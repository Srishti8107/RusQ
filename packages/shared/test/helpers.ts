import {
  generateServerKeyPair,
  generateTeamKeyB64,
  importServerPrivateKey,
  importServerPublicKey,
  importTeamKey,
  MeshNode,
  mulberry32,
  seededUuid,
  signAck,
  type Ack,
  type FieldReport,
  type Sos,
} from '../src/index.ts';

export interface Keys {
  teamKey: CryptoKey;
  otherTeamKey: CryptoKey;
  serverPriv: CryptoKey;
  serverPub: CryptoKey;
  rogueServerPriv: CryptoKey;
}

let cached: Keys | null = null;
export async function keys(): Promise<Keys> {
  if (cached) return cached;
  const s = await generateServerKeyPair();
  const rogue = await generateServerKeyPair();
  cached = {
    teamKey: await importTeamKey(await generateTeamKeyB64()),
    otherTeamKey: await importTeamKey(await generateTeamKeyB64()),
    serverPriv: await importServerPrivateKey(s.privateJwk),
    serverPub: await importServerPublicKey(s.publicJwk),
    rogueServerPriv: await importServerPrivateKey(rogue.privateJwk),
  };
  return cached;
}

export function idGen(seed = 1) {
  return seededUuid(mulberry32(seed));
}

export async function makeNode(id: string, opts: { teamKey?: CryptoKey; now?: () => number; seed?: number } = {}) {
  const k = await keys();
  return new MeshNode({
    nodeId: id,
    teamKey: opts.teamKey ?? k.teamKey,
    serverPublicKey: k.serverPub,
    now: opts.now ?? (() => 1_700_000_000_000),
    newId: idGen(opts.seed ?? id.charCodeAt(id.length - 1)),
  });
}

export function sampleSos(id: string): Sos {
  return {
    id,
    userId: '01890000-0000-7000-8000-000000000001',
    lat: 26.14,
    lng: 91.73,
    accuracy: 15,
    locationSource: 'live',
    createdAt: '2026-07-01T10:00:00.000Z',
    source: 'app',
  };
}

export function sampleReport(id: string): FieldReport {
  return {
    id,
    teamId: 'team-alpha',
    lat: 26.15,
    lng: 91.74,
    locationSource: 'live',
    victimCount: 12,
    urgency: 4,
    notes: 'Water rising, elderly on roof',
    photos: [],
    requested: { boats: 2, food_water: 40 },
    aiSuggestion: null,
    humanFinal: { hazards: ['flooded street'], victimCount: 12, urgency: 4, requested: { boats: 2, food_water: 40 } },
    createdAt: '2026-07-01T10:05:00.000Z',
  };
}

export async function serverAck(clientId: string, kind: Ack['kind'] = 'sos', priv?: CryptoKey): Promise<Ack> {
  const k = await keys();
  return signAck(priv ?? k.serverPriv, {
    clientId,
    kind,
    serverId: `srv-${clientId.slice(0, 8)}`,
    receivedAt: '2026-07-01T11:00:00.000Z',
    duplicate: false,
  });
}
