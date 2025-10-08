import fs from 'fs';
import path from 'path';
import https from 'https';

function parseCSV(text) {
  const rows = [];
  let i = 0;
  const len = text.length;
  let row = [];
  let field = '';
  let inQuotes = false;

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i+1] === '"') { field += '"'; i += 2; continue; } else { inQuotes = false; i++; continue; }
      } else { field += ch; i++; continue; }
    } else {
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += ch; i++;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function timeToMinutes(t) {
  // t like HH:MM:SS, hours may be >=24
  const parts = (t||'00:00:00').split(':').map(x=>parseInt(x,10)||0);
  return parts[0]*60 + parts[1] + parts[2]/60;
}

export default async function handler(req, res) {
  try {
    const { origin, dest, maxResults } = req.query;
    const agency = req.query.agency || '7011501003070';
    if (!origin || !dest) return res.status(400).json({ error: 'origin and dest required' });

    const fp_stop_times = path.join(process.cwd(), 'public', 'gtfs', 'stop_times.txt');
    const fp_trips = path.join(process.cwd(), 'public', 'gtfs', 'trips.txt');
    const fp_routes = path.join(process.cwd(), 'public', 'gtfs', 'routes.txt');
    if (!fs.existsSync(fp_stop_times) || !fs.existsSync(fp_trips)) return res.status(500).json({ error: 'GTFS files missing' });

    const stopTimesText = fs.readFileSync(fp_stop_times, 'utf8');
    const rows = parseCSV(stopTimesText);
  if (!rows || rows.length === 0) return res.status(500).json({ error: 'stop_times.txt parse returned no rows' });
  const header = rows[0].map(h=>h.trim());
    const data = rows.slice(1);

    // Build map: trip_id -> list of stop_time entries
    const tripMap = new Map();
    for (const r of data) {
      const obj = {};
      for (let i=0;i<header.length;i++) obj[header[i]] = r[i] === undefined ? '' : r[i];
      const trip_id = obj.trip_id;
      if (!tripMap.has(trip_id)) tripMap.set(trip_id, []);
      tripMap.get(trip_id).push(obj);
    }

    // Read trips -> route_id
    const tripsText = fs.readFileSync(fp_trips, 'utf8');
    const tripsRows = parseCSV(tripsText);
  if (!tripsRows || tripsRows.length === 0) return res.status(500).json({ error: 'trips.txt parse returned no rows' });
  const tripsHeader = tripsRows[0].map(h=>h.trim());
    const tripsData = tripsRows.slice(1);
    const tripToRoute = {};
    for (const r of tripsData) {
      const obj = {};
      for (let i=0;i<tripsHeader.length;i++) obj[tripsHeader[i]] = r[i] === undefined ? '' : r[i];
      if (obj.trip_id) tripToRoute[obj.trip_id] = obj.route_id;
    }

    // routes
    const routes = {};
    if (fs.existsSync(fp_routes)) {
      const rt = fs.readFileSync(fp_routes,'utf8');
      const rr = parseCSV(rt); const rh = rr[0].map(h=>h.trim()); const rd = rr.slice(1);
      for (const r of rd) { const o={}; for (let i=0;i<rh.length;i++) o[rh[i]]=r[i]||''; if (o.route_id) routes[o.route_id]=o; }
    }

    // now minutes (fractional)
    const now = new Date();
    const nowMinutes = now.getHours()*60 + now.getMinutes() + now.getSeconds()/60;

    // collect candidate trips where origin stop exists and dest exists later in sequence
    const candidates = [];
    for (const [tripId, stopsList] of tripMap.entries()) {
      let originEntry = null, destEntry = null;
      for (const st of stopsList) {
        if (st.stop_id === origin) originEntry = st;
      }
      if (!originEntry) continue;
      for (const st of stopsList) {
        if (st.stop_id === dest) destEntry = st;
      }
      if (!destEntry) continue;
      const oseq = parseInt(originEntry.stop_sequence||'0',10);
      const dseq = parseInt(destEntry.stop_sequence||'0',10);
      if (isNaN(oseq) || isNaN(dseq) || dseq <= oseq) continue;

      const originMinRaw = timeToMinutes(originEntry.departure_time || originEntry.arrival_time || '00:00:00');
      // if scheduled earlier than now, consider it as next day (add 24h)
      let scheduled = originMinRaw;
      if (scheduled < nowMinutes) scheduled += 24*60;
      const delta = scheduled - nowMinutes;
      if (delta < 0 || delta > 24*60) continue; // ignore weird

      const routeId = tripToRoute[tripId] || null;
      const route = routeId ? (routes[routeId] ? (routes[routeId].route_short_name || routes[routeId].route_long_name) : routeId) : null;

      candidates.push({ tripId, routeId, route, originTime: originEntry.departure_time || originEntry.arrival_time, destTime: destEntry.arrival_time || destEntry.departure_time, deltaMinutes: Math.round(delta), originSeq: oseq, destSeq: dseq });
    }

    candidates.sort((a,b)=>a.deltaMinutes - b.deltaMinutes);
    const maxR = parseInt(maxResults||'3',10) || 3;
    // try to fetch realtime feed to prioritize active trips
    try {
      const url = `https://api.ottop.org/realtime/${agency}/vehiclePositions`;
      const buffer = await new Promise((resolve, reject) => {
        https.get(url, (resp) => {
          const { statusCode } = resp;
          if (!statusCode || statusCode < 200 || statusCode >= 300) return reject(new Error('upstream status ' + statusCode));
          const chunks = [];
          resp.on('data', (c) => chunks.push(c));
          resp.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
      });

      let FeedMessage;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Gtfs = require('gtfs-realtime-bindings');
        FeedMessage = Gtfs.FeedMessage || (Gtfs.transit_realtime && Gtfs.transit_realtime.FeedMessage);
      } catch (e) {
        FeedMessage = undefined;
      }

      const activeTripIds = new Set();
      if (FeedMessage && typeof FeedMessage.decode === 'function') {
        try {
          const feed = FeedMessage.decode(buffer);
          const ents = (feed && feed.entity) || [];
          for (const e of ents) {
            const trip = e?.vehicle?.trip;
            if (trip && trip.trip_id) activeTripIds.add(trip.trip_id);
            // also consider tripUpdate entities
            const tu = e?.tripUpdate;
            if (tu && tu.trip && tu.trip.trip_id) activeTripIds.add(tu.trip.trip_id);
          }
        } catch (e) {
          // ignore decode errors — continue without realtime
        }
      }

      // mark candidates that are active
      for (const c of candidates) c.active = !!(c.tripId && activeTripIds.has(c.tripId));
      // sort: active first (by delta), then others by delta
      candidates.sort((a,b) => {
        if (a.active && !b.active) return -1;
        if (!a.active && b.active) return 1;
        return a.deltaMinutes - b.deltaMinutes;
      });

    } catch (e) {
      // if realtime fetch fails, just proceed with schedule-only candidates
    }

    // diagnostics: count how many trips include origin/dest (helps debug mismatched IDs)
    let tripsWithOrigin = 0, tripsWithDest = 0;
    let sampleOriginRow = null;
    let sampleDestRow = null;
    for (const [tripId, stopsList] of tripMap.entries()) {
      let hasO=false, hasD=false;
      for (const st of stopsList) {
        if (st.stop_id === origin) { hasO = true; if (!sampleOriginRow) sampleOriginRow = st; }
        if (st.stop_id === dest) { hasD = true; if (!sampleDestRow) sampleDestRow = st; }
      }
      if (hasO) tripsWithOrigin++;
      if (hasD) tripsWithDest++;
    }

    // if no direct candidates found, fallback: return next departures from origin stop
    if (candidates.length === 0) {
      const fallback = [];
      for (const [tripId, stopsList] of tripMap.entries()) {
        for (const st of stopsList) {
          if (st.stop_id === origin) {
            const originMinRaw = timeToMinutes(st.departure_time || st.arrival_time || '00:00:00');
            let scheduled = originMinRaw;
            if (scheduled < nowMinutes) scheduled += 24*60;
            const delta = scheduled - nowMinutes;
            if (delta >= 0 && delta <= 24*60) {
              const routeId = tripToRoute[tripId] || null;
              fallback.push({ tripId, routeId, originTime: st.departure_time || st.arrival_time, deltaMinutes: Math.round(delta) });
            }
            break;
          }
        }
      }
      fallback.sort((a,b)=>a.deltaMinutes - b.deltaMinutes);
      console.log('routeCandidates diagnostics', { origin, dest, tripsWithOrigin, tripsWithDest, sampleOriginRow: sampleOriginRow ? { stop_id: sampleOriginRow.stop_id, arrival_time: sampleOriginRow.arrival_time, departure_time: sampleOriginRow.departure_time } : null, sampleDestRow: sampleDestRow ? { stop_id: sampleDestRow.stop_id, arrival_time: sampleDestRow.arrival_time, departure_time: sampleDestRow.departure_time } : null });
      return res.status(200).json({ candidates: fallback.slice(0,maxR), fallback: true, diagnostics: { tripsWithOrigin, tripsWithDest, sampleOrigin: sampleOriginRow, sampleDest: sampleDestRow } });
    }

    res.status(200).json({ candidates: candidates.slice(0,maxR) });
  } catch (err) {
    console.error('routeCandidates error', err);
    const safeStack = err && err.stack ? err.stack.toString() : String(err);
    res.status(500).json({ error: String(err), stack: safeStack });
  }
}
  // diagnostics: count how many trips include origin/dest (helps debug mismatched IDs)
  let tripsWithOrigin = 0, tripsWithDest = 0;
  let sampleOriginRow = null;
  let sampleDestRow = null;
  for (const [tripId, stopsList] of tripMap.entries()) {
    let hasO=false, hasD=false;
    for (const st of stopsList) {
    if (st.stop_id === origin) { hasO = true; if (!sampleOriginRow) sampleOriginRow = st; }
    if (st.stop_id === dest) { hasD = true; if (!sampleDestRow) sampleDestRow = st; }
    }
    if (hasO) tripsWithOrigin++;
    if (hasD) tripsWithDest++;
  }

  console.log('routeCandidates diagnostics', { origin, dest, tripsWithOrigin, tripsWithDest, sampleOriginRow: sampleOriginRow ? { stop_id: sampleOriginRow.stop_id, arrival_time: sampleOriginRow.arrival_time, departure_time: sampleOriginRow.departure_time } : null, sampleDestRow: sampleDestRow ? { stop_id: sampleDestRow.stop_id, arrival_time: sampleDestRow.arrival_time, departure_time: sampleDestRow.departure_time } : null });
