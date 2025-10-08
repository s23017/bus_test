import https from 'https';
let FeedMessage;
try {
  // require to be robust in CommonJS/ESM environments
  // the package may export differently, so check common shapes
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Gtfs = require('gtfs-realtime-bindings');
  FeedMessage = Gtfs.FeedMessage || (Gtfs.transit_realtime && Gtfs.transit_realtime.FeedMessage);
} catch (e) {
  // will handle later when used
  FeedMessage = undefined;
}

// fallback: try to resolve via protobufjs if available and gtfs-realtime-bindings shape is unexpected
try {
  if (!FeedMessage) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const protobuf = require('protobufjs');
    // try to load the compiled gtfs-realtime proto from gtfs-realtime-bindings package if present
    try {
      // some installs expose the .proto compiled JSON
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const bindingPath = require.resolve('gtfs-realtime-bindings');
      // attempt to require the package and inspect for transit_realtime
      const Gtfs2 = require('gtfs-realtime-bindings');
      FeedMessage = Gtfs2.FeedMessage || (Gtfs2.transit_realtime && Gtfs2.transit_realtime.FeedMessage);
    } catch (e2) {
      // last resort: try to fetch proto via protobufjs from known schema (may fail without network)
      // skip network fetch in this environment — leave FeedMessage undefined
    }
  }
} catch (e) {
  // ignore
}

export default async function handler(req, res) {
  let { agencyId } = req.query;
  if (Array.isArray(agencyId)) agencyId = agencyId[0];
  const url = `https://api.ottop.org/realtime/${agencyId}/vehiclePositions`;

  try {
    const buffer = await new Promise((resolve, reject) => {
      https.get(url, (resp) => {
        const { statusCode } = resp;
        if (!statusCode || statusCode < 200 || statusCode >= 300) {
          return reject(new Error(`Upstream responded with status ${statusCode}`));
        }
        const chunks = [];
        resp.on('data', (chunk) => chunks.push(chunk));
        resp.on('end', () => {
          try {
            resolve(Buffer.concat(chunks));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', (err) => reject(err));
    });

    if (!FeedMessage || typeof FeedMessage.decode !== 'function') {
      console.error('FeedMessage not available', { FeedMessageType: typeof FeedMessage });
      return res.status(502).json({ error: 'Server misconfiguration: FeedMessage.decode not available', feedMessageAvailable: !!FeedMessage });
    }

    let feed;
    try {
      feed = FeedMessage.decode(buffer);
    } catch (e) {
      console.error('decode error', e && e.message ? e.message : e);
      return res.status(502).json({ error: 'Failed to decode GTFS-RT feed', detail: String(e) });
    }
    // convert to plain JSON-friendly structure
  const entities = (feed && feed.entity ? feed.entity : []).map((e) => {
      const out = { id: e.id };
      if (e.vehicle) {
        out.vehicle = {
          trip: e.vehicle.trip ? { trip_id: e.vehicle.trip.trip_id, route_id: e.vehicle.trip.route_id } : null,
          position: e.vehicle.position ? { latitude: e.vehicle.position.latitude, longitude: e.vehicle.position.longitude, bearing: e.vehicle.position.bearing, speed: e.vehicle.position.speed } : null,
          timestamp: e.vehicle.timestamp || null,
          vehicle: e.vehicle.vehicle ? { id: e.vehicle.vehicle.id, label: e.vehicle.vehicle.label } : null,
          stop_id: e.vehicle.stopId || null,
          delay: e.vehicle.delay || null,
        };
      }
      if (e.tripUpdate) {
        out.tripUpdate = e.tripUpdate; // simple pass-through
      }
      return out;
    });

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ entity: entities });
  } catch (err) {
    console.error('proxy error', err);
    // include stack and FeedMessage presence to help debugging in dev
    const safeErr = err && err.stack ? err.stack.toString() : String(err);
    const feedMsgInfo = FeedMessage ? Object.keys(FeedMessage).slice(0,20) : null;
    res.status(500).json({ error: String(err), stack: safeErr, feedMessageAvailable: !!FeedMessage, feedMsgInfo });
  }
}
