package org.rusq.field;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // local plugin: phone-to-phone link without internet (Bluetooth / Wi-Fi Direct)
        registerPlugin(NearbyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
