"use client";

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import axios from 'axios';
import styles from './BusMap.module.css';

const DynamicMap = dynamic(() => import('./Map'), {
  ssr: false, // ← これがポイント！
});

export default function BusMap() {
  const [busData, setBusData] = useState<any[]>([]);
  const [stops, setStops] = useState<any[]>([]);
  const [userLocation, setUserLocation] = useState<{lat:number;lon:number}|null>(null);
  const [destLocation, setDestLocation] = useState<{lat:number;lon:number}|null>(null);
  const [originStop, setOriginStop] = useState<any|null>(null);
  const [destStop, setDestStop] = useState<any|null>(null);
  const [etas, setEtas] = useState<Array<any>>([]);

  useEffect(() => {
    const fetchBusPositions = async () => {
      let attempts = 0;
      while (attempts < 3) {
        try {
          // call server-side proxy that decodes GTFS-RT protobuf
          const res = await axios.get(`/api/realtime/7011501003070/vehiclePositions`);
          setBusData((res.data as any).entity || []);
          break;
        } catch (err: any) {
          attempts++;
          console.warn(`バス位置取得エラー (試行 ${attempts}):`, err?.response?.data ?? err?.message ?? err);
          if (attempts >= 3) {
            // surface a user-friendly message but don't throw
            setBusData([]);
            // keep retrying on next interval
          } else {
            // small backoff
            await new Promise(r => setTimeout(r, 500 * attempts));
          }
        }
      }
    };

    const fetchStops = async () => {
      try {
        const r = await axios.get('/api/stops');
        setStops((r.data as any).stops || []);
        console.info('GTFS stops loaded:', (r.data as any).stops.length);
      } catch (e) {
        console.error('停留所取得エラー:', e);
        // fallback to public/stops.json
        try {
          const local = await axios.get('/stops.json');
          setStops((local.data as any).stops || []);
          console.info('ローカル停留所を読み込みました（フォールバック）');
        } catch (le) {
          const _le: any = le;
          console.error('ローカル停留所読み込み失敗:', _le?.message ?? _le);
        }
      }
    };

    fetchBusPositions();
    fetchStops();

    const id = setInterval(() => {
      fetchBusPositions();
    }, 10000);

    return () => clearInterval(id);
  }, []);

  // get user location on demand
  const locateUser = () => {
    if (!navigator.geolocation) return alert('このブラウザでは位置情報が取得できません');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        setUserLocation({lat, lon});
        // compute nearest stop
        const nearest = findNearestStop(lat, lon, stops);
        setOriginStop(nearest);
      },
      (err) => {
        console.warn('位置情報取得エラー', err);
        alert('位置情報の取得に失敗しました');
      }
    );
  };

  // search UI state
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);

  const onSearch = (q:string) => {
    setQuery(q);
    if (!q) { setResults([]); return; }
    const lower = q.toLowerCase();
    const matched = (stops || []).filter(s => (s.name || s.stop_name || '').toLowerCase().includes(lower)).slice(0,10);
    setResults(matched);
  };

  const selectResult = (stop:any) => {
    const lat = stop.latitude ?? parseFloat(stop.stop_lat) ?? null;
    const lon = stop.longitude ?? parseFloat(stop.stop_lon) ?? null;
    if (lat && lon) {
      onDestinationSelected(lat, lon);
      setResults([]);
      setQuery(stop.name ?? stop.stop_name ?? stop.stop_id ?? '');
    }
  };

  // compute nearest stop utility
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const haversineKm = (lat1:number, lon1:number, lat2:number, lon2:number) => {
    const R = 6371; // km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };

  const findNearestStop = (lat:number, lon:number, list:any[]) => {
    if (!Array.isArray(list) || list.length === 0) return null;
    let best = null;
    let bestD = Infinity;
    for (const s of list) {
      const slat = s?.latitude ?? s?.lat ?? s?.location?.lat;
      const slon = s?.longitude ?? s?.lng ?? s?.location?.lon ?? s?.location?.lng;
      if (typeof slat !== 'number' || typeof slon !== 'number') continue;
      const d = haversineKm(lat, lon, slat, slon);
      if (d < bestD) { bestD = d; best = {stop: s, distanceKm: d}; }
    }
    return best;
  };

  // when destination selected (from Map click), compute nearest stops and ETAs
  const onDestinationSelected = (lat:number, lon:number) => {
    setDestLocation({lat, lon});
    const nearestDest = findNearestStop(lat, lon, stops);
    setDestStop(nearestDest);
    // compute ETAs from buses to dest stop
    if (nearestDest) {
      const destLat = nearestDest.stop.latitude ?? nearestDest.stop.lat ?? nearestDest.stop.location?.lat;
      const destLon = nearestDest.stop.longitude ?? nearestDest.stop.lng ?? nearestDest.stop.location?.lon ?? nearestDest.stop.location?.lng;
      const computed = (busData || []).map((bus:any) => {
        const blat = bus?.vehicle?.position?.latitude;
        const blon = bus?.vehicle?.position?.longitude;
        if (typeof blat !== 'number' || typeof blon !== 'number') return null;
        const distKm = haversineKm(blat, blon, destLat, destLon);
        const speedKmh = 20; // 仮定の平均速度
        const etaMin = (distKm / speedKmh) * 60;
        return {
          id: bus?.vehicle?.vehicle?.id ?? bus?.id ?? Math.random().toString(36).slice(2,8),
          route: bus?.vehicle?.trip?.route_id ?? '不明',
          lat: blat,
          lon: blon,
          distanceKm: distKm,
          etaMin: Math.round(etaMin),
          delay: bus?.vehicle?.delay ?? null,
        };
      }).filter(Boolean).sort((a:any,b:any)=>a.etaMin - b.etaMin);
      setEtas(computed);
    } else {
      setEtas([]);
    }
  };

  const [routeCandidates, setRouteCandidates] = useState<any[]>([]);
  const fetchRouteCandidates = async () => {
    if (!originStop || !destStop) return alert('起点と目的地の停留所を設定してください');
    try {
      const originId = originStop.stop.stop_id || originStop.stop.stop_id;
      const destId = destStop.stop.stop_id || destStop.stop.stop_id;
  const r = await axios.get(`/api/routeCandidates?origin=${encodeURIComponent(originId)}&dest=${encodeURIComponent(destId)}&maxResults=3`);
  const d: any = r.data;
  setRouteCandidates(d.candidates || []);
    } catch (e) {
      // show helpful error information when available
      const err: any = e;
      console.error('route candidates error', err);
      if (err?.response?.data) {
        // server returned JSON or HTML — show a trimmed preview
        const body = typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data, null, 2);
        alert('ルート候補の取得に失敗しました。サーバー応答:\n' + body.slice(0, 1000));
      } else {
        alert('ルート候補の取得に失敗しました: ' + (err?.message || err));
      }
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.main}>
        <h2>沖縄バス現在位置</h2>
        <div className={styles.headerRow}>
          <div className={styles.controls}>
            <button className={styles.btn} onClick={locateUser}>現在地を取得</button>
            <span className={styles.metaRow}>{userLocation ? `現在地: ${userLocation.lat.toFixed(5)}, ${userLocation.lon.toFixed(5)}` : '現在地未取得'}</span>
          </div>
        </div>

        <div className={styles.searchRow}>
          <input className={styles.searchInput} value={query} onChange={e=>onSearch(e.target.value)} placeholder="名所・停留所を検索" />
          <button className={`${styles.btn} ${styles.secondary}`} onClick={()=>onSearch(query)} style={{marginLeft:8}}>検索</button>
          {results.length > 0 && (
            <div className={styles.resultsList}>
              {results.map(r=> (
                <div key={r.stop_id} className={styles.resultItem} onClick={()=>selectResult(r)}>
                  {r.name ?? r.stop_name ?? r.stop_id}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={styles.mapWrapper}>
          <DynamicMap buses={busData} stops={stops} userLocation={userLocation} originStop={originStop} destStop={destStop} onMapClick={onDestinationSelected} />
        </div>
      </div>
      <aside className={styles.aside}>
        <h3>経路候補</h3>
        <div>
          <div>起点停留所: {originStop ? `${originStop.stop.name ?? originStop.stop.stop_name ?? originStop.stop.stop_id} (${originStop.distanceKm.toFixed(2)} km)` : '未設定'}</div>
          <div>目的地に近い停留所: {destStop ? `${destStop.stop.name ?? destStop.stop.stop_name ?? destStop.stop.stop_id} (${destStop.distanceKm.toFixed(2)} km)` : '地図をクリックして選択'}</div>
        </div>
        <div className={styles.sectionTitle}>到着予想 (近い順)</div>
        <ul className={styles.etaList}>
          {etas.length === 0 && <li className={styles.small}>候補なし</li>}
          {etas.map((e:any)=>(
            <li key={e.id}>
              <strong>ルート:</strong> {e.route} <span className={styles.small}>ETA: 約 {e.etaMin} 分</span>
              <div className={styles.small}>距離: {e.distanceKm.toFixed(2)} km - 遅延: {e.delay != null ? e.delay : '不明'}</div>
            </li>
          ))}
        </ul>
        <div className={styles.panelButton}>
          <button className={styles.btn} onClick={fetchRouteCandidates}>乗るバス・ルート候補を検索</button>
        </div>
        <div className={styles.sectionTitle}>乗車候補（直近）</div>
        <ul className={styles.routeList}>
          {routeCandidates.length === 0 && <li className={styles.small}>候補なし（検索ボタンを押してください）</li>}
          {routeCandidates.map((c:any)=>(
            <li key={c.tripId}>
              <div><strong>便:</strong> {c.tripId} - <strong>ルート:</strong> {c.route ?? c.routeId}</div>
              <div className={styles.small}>発時刻: {c.originTime} → 到着: {c.destTime} （発車まで: {c.deltaMinutes} 分）</div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
