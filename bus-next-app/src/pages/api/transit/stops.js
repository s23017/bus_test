import https from 'https';

export default async function handler(req, res) {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const url = `https://api.ottop.org/transit/stops?${qs}`;
    const buffer = await new Promise((resolve, reject) => {
      https.get(url, (resp) => {
        const { statusCode } = resp;
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => {
          if (!statusCode || statusCode < 200 || statusCode >= 300) return reject(new Error('upstream status ' + statusCode));
          resolve(Buffer.concat(chunks));
        });
      }).on('error', reject);
    });
    const text = buffer.toString('utf8');
    try { return res.status(200).json(JSON.parse(text)); } catch (e) { return res.status(200).send(text); }
  } catch (err) {
    console.error('transit/stops proxy error', err);
    res.status(500).json({ error: String(err) });
  }
}
