import fs from 'fs';
import path from 'path';

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
        if (text[i+1] === '"') { // escaped quote
          field += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        field += ch;
        i++;
        continue;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (ch === ',') {
        row.push(field);
        field = '';
        i++;
        continue;
      }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i++;
        continue;
      }
      field += ch;
      i++;
    }
  }
  // last field
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export default function handler(req, res) {
  try {
    const fp = path.join(process.cwd(), 'public', 'gtfs', 'stops.txt');
    if (!fs.existsSync(fp)) {
      return res.status(404).json({ error: 'stops.txt not found' });
    }
    const txt = fs.readFileSync(fp, 'utf8');
    const rows = parseCSV(txt);
    if (rows.length === 0) return res.status(200).json({ stops: [] });
    const header = rows[0].map(h=>h.trim());
    const data = rows.slice(1).map(r => {
      const obj = {};
      for (let i=0;i<header.length;i++) {
        obj[header[i]] = r[i] === undefined ? '' : r[i];
      }
      return obj;
    });
    // map to common fields
    const stops = data.map(s => ({
      stop_id: s.stop_id || s.stop_code || null,
      name: s.stop_name || s.stop_desc || '',
      latitude: parseFloat(s.stop_lat) || null,
      longitude: parseFloat(s.stop_lon) || null,
      raw: s,
    })).filter(s => s.latitude !== null && s.longitude !== null);

    res.status(200).json({ stops });
  } catch (err) {
    console.error('stops api error', err);
    res.status(500).json({ error: String(err) });
  }
}
