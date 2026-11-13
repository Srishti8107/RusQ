package org.rusq.field;

import android.Manifest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Phone-to-phone link for RusQ without internet: Google Nearby Connections (Bluetooth, BLE and
 * Wi-Fi Direct / hotspot, chosen by Android). Every phone advertises AND discovers with
 * P2P_CLUSTER (many-to-many) and links to every RusQ phone in range.
 *
 * Trust is NOT based on the link: the web layer only accepts relay messages that carry the
 * team-key MAC, and confirmations signed by the server (packages/shared/src/mesh).
 *
 * JS side: apps/web/src/lib/nearby.ts. Events: connected {endpointId, name}, disconnected
 * {endpointId}, message {endpointId, data}, status {state, detail}.
 */
@CapacitorPlugin(
    name = "Nearby",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "bluetooth", strings = { "android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_ADVERTISE", "android.permission.BLUETOOTH_CONNECT" }),
        @Permission(alias = "wifi", strings = { "android.permission.NEARBY_WIFI_DEVICES" }),
    }
)
public class NearbyPlugin extends Plugin {

    private static final Strategy STRATEGY = Strategy.P2P_CLUSTER;
    private ConnectionsClient client;
    private String localName = "rusq";
    private String serviceId = "org.rusq.field.relay.v1";
    private boolean running = false;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<String> connected = ConcurrentHashMap.newKeySet();
    private final Set<String> pending = ConcurrentHashMap.newKeySet();
    private final Map<String, String> names = new ConcurrentHashMap<>();

    @Override
    public void load() {
        client = Nearby.getConnectionsClient(getContext());
    }

    /* ------------------------------ permissions ------------------------------ */

    /** Only the permissions this Android version actually has (older versions grant Bluetooth at install). */
    private String[] neededAliases() {
        List<String> a = new ArrayList<>();
        a.add("location");
        if (Build.VERSION.SDK_INT >= 31) a.add("bluetooth");
        if (Build.VERSION.SDK_INT >= 33) a.add("wifi");
        return a.toArray(new String[0]);
    }

    private JSObject states() {
        JSObject r = new JSObject();
        for (String alias : neededAliases()) r.put(alias, getPermissionState(alias).toString());
        return r;
    }

    @Override
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        call.resolve(states());
    }

    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        requestPermissionForAliases(neededAliases(), call, "permissionsDone");
    }

    @PermissionCallback
    private void permissionsDone(PluginCall call) {
        call.resolve(states());
    }

    private boolean allGranted() {
        for (String alias : neededAliases()) if (getPermissionState(alias) != PermissionState.GRANTED) return false;
        return true;
    }

    /* ------------------------------ start / stop ------------------------------ */

    @PluginMethod
    public void start(PluginCall call) {
        if (!allGranted()) {
            call.reject("Nearby devices / location permission missing");
            return;
        }
        localName = call.getString("name", "rusq");
        serviceId = call.getString("serviceId", serviceId);
        if (running) {
            call.resolve();
            return;
        }
        running = true;
        client
            .startAdvertising(localName, serviceId, lifecycle, new AdvertisingOptions.Builder().setStrategy(STRATEGY).build())
            .addOnFailureListener(e -> status("error", "advertising: " + e.getMessage()));
        client
            .startDiscovery(serviceId, discovery, new DiscoveryOptions.Builder().setStrategy(STRATEGY).build())
            .addOnFailureListener(e -> status("error", "discovery: " + e.getMessage()));
        status("on", null);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        running = false;
        client.stopAdvertising();
        client.stopDiscovery();
        client.stopAllEndpoints();
        connected.clear();
        pending.clear();
        status("off", null);
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String id = call.getString("endpointId");
        String data = call.getString("data");
        if (id == null || data == null || !connected.contains(id)) {
            call.reject("not connected");
            return;
        }
        client
            .sendPayload(id, Payload.fromBytes(data.getBytes(StandardCharsets.UTF_8)))
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> call.reject(e.getMessage()));
    }

    @Override
    protected void handleOnDestroy() {
        if (client != null) {
            client.stopAdvertising();
            client.stopDiscovery();
            client.stopAllEndpoints();
        }
    }

    /* ------------------------------ callbacks ------------------------------ */

    private void request(String endpointId) {
        if (!running || connected.contains(endpointId) || pending.contains(endpointId)) return;
        pending.add(endpointId);
        client
            .requestConnection(localName, endpointId, lifecycle)
            .addOnFailureListener(e -> {
                pending.remove(endpointId);
                // the other phone dialled us at the same moment – its connection wins
                if (!(e.getMessage() != null && e.getMessage().contains(String.valueOf(ConnectionsStatusCodes.STATUS_ALREADY_CONNECTED_TO_ENDPOINT)))) {
                    main.postDelayed(() -> request(endpointId), 5000);
                }
            });
    }

    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo info) {
            if (!serviceId.equals(info.getServiceId())) return;
            names.put(endpointId, info.getEndpointName());
            // Only one side dials (smaller name), so two phones do not collide. The other side
            // dials too after a pause in case it was never discovered.
            if (localName.compareTo(info.getEndpointName()) < 0) request(endpointId);
            else main.postDelayed(() -> request(endpointId), 8000);
        }

        @Override
        public void onEndpointLost(@NonNull String endpointId) {
            pending.remove(endpointId);
        }
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo info) {
            names.put(endpointId, info.getEndpointName());
            client.acceptConnection(endpointId, payloads);
        }

        @Override
        public void onConnectionResult(@NonNull String endpointId, @NonNull ConnectionResolution result) {
            pending.remove(endpointId);
            if (result.getStatus().isSuccess()) {
                connected.add(endpointId);
                JSObject e = new JSObject();
                e.put("endpointId", endpointId);
                e.put("name", names.getOrDefault(endpointId, ""));
                notifyListeners("connected", e, true);
            } else if (running) {
                main.postDelayed(() -> request(endpointId), 6000);
            }
        }

        @Override
        public void onDisconnected(@NonNull String endpointId) {
            connected.remove(endpointId);
            JSObject e = new JSObject();
            e.put("endpointId", endpointId);
            notifyListeners("disconnected", e, true);
        }
    };

    private final PayloadCallback payloads = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            if (payload.getType() != Payload.Type.BYTES || payload.asBytes() == null) return;
            JSObject e = new JSObject();
            e.put("endpointId", endpointId);
            e.put("data", new String(payload.asBytes(), StandardCharsets.UTF_8));
            // retain until the web layer listens (e.g. the WebView was still loading)
            notifyListeners("message", e, true);
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) {
            /* BYTES payloads arrive whole */
        }
    };

    private void status(String state, String detail) {
        JSObject e = new JSObject();
        e.put("state", state);
        if (detail != null) e.put("detail", detail);
        notifyListeners("status", e);
    }
}
