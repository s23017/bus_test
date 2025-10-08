"use client";

import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
// Replace Leaflet default marker icons with an inline SVG data URL to avoid 404 when
// the default images are not served from node_modules in Next.js setups.
try {
  const svg = `
    <svg xmlns='http://www.w3.org/2000/svg' width='32' height='40' viewBox='0 0 32 40'>
      <path d='M16 0C9 0 4 5 4 11c0 8 12 23 12 23s12-15 12-23C28 5 23 0 16 0z' fill='%23006aa3' stroke='%2300344a' stroke-width='1'/>
      <circle cx='16' cy='11' r='4' fill='white'/>
    </svg>
  `;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  L.Icon.Default.mergeOptions({ iconUrl: url, iconRetinaUrl: url, shadowUrl: '' });
} catch (e) {
  // ignore if mergeOptions fails in some environments
}

const busIcon = new L.Icon({
  iconUrl: 'https://cdn-icons-png.flaticon.com/512/61/61088.png',
  iconSize: [25, 25],
});

const stopIcon = new L.Icon({
  iconUrl: 'https://cdn-icons-png.flaticon.com/512/252/252025.png',
  iconSize: [18, 18],
});
function ClickHandler({ onMapClick }:{onMapClick?: (lat:number, lon:number)=>void}){
  useMapEvents({
    click(e){
      onMapClick?.(e.latlng.lat, e.latlng.lng);
    }
  });
  return null;
}

export default function Map({ buses, stops, userLocation, originStop, destStop, onMapClick }: { buses: any[]; stops?: any[]; userLocation?: {lat:number;lon:number}|null; originStop?: any; destStop?: any; onMapClick?: (lat:number, lon:number)=>void }) {
  return (
    <MapContainer center={[26.2123, 127.6792]} zoom={13} style={{ height: '600px', width: '100%' }}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <ClickHandler onMapClick={onMapClick} />
      {Array.isArray(stops) && stops.map((stop, i) => {
        // try common field names
        const lat = stop?.lat ?? stop?.latitude ?? stop?.location?.lat;
        const lon = stop?.lng ?? stop?.longitude ?? stop?.location?.lon ?? stop?.location?.lng;
        if (typeof lat !== 'number' || typeof lon !== 'number') return null;
        const sid = stop?.stop_id ?? stop?.id ?? i;
        return (
          <Marker key={`stop-${sid}`} position={[lat, lon]} icon={stopIcon}>
            <Popup>
              <div>
                <strong>{stop?.name ?? stop?.stop_name ?? '停留所'}</strong>
                <div>停留所ID: {sid}</div>
              </div>
            </Popup>
          </Marker>
        );
      })}
      {buses.map((bus, idx) => {
        const lat = bus?.vehicle?.position?.latitude;
        const lon = bus?.vehicle?.position?.longitude;
        if (typeof lat !== 'number' || typeof lon !== 'number') return null;
        const id = bus?.vehicle?.vehicle?.id ?? idx;
        return (
          <Marker
            key={id}
            position={[lat, lon]}
            icon={busIcon}
          >
            <Popup>
              <div>
                <p>🚌 バスID: {id}</p>
                <p>路線ID: {bus?.vehicle?.trip?.route_id ?? '不明'}</p>
                <p>停留所ID: {bus?.vehicle?.stop_id ?? '不明'}</p>
              </div>
            </Popup>
          </Marker>
        );
      })}
      {userLocation && (
        <Marker position={[userLocation.lat, userLocation.lon]} key="user-location">
          <Popup>あなたの現在地</Popup>
        </Marker>
      )}
      {originStop && originStop.stop && (
        <Marker position={[originStop.stop.latitude ?? originStop.stop.lat, originStop.stop.longitude ?? originStop.stop.lng]} key="origin-stop">
          <Popup>起点: {originStop.stop.name ?? originStop.stop.stop_name ?? originStop.stop.stop_id}</Popup>
        </Marker>
      )}
      {destStop && destStop.stop && (
        <Marker position={[destStop.stop.latitude ?? destStop.stop.lat, destStop.stop.longitude ?? destStop.stop.lng]} key="dest-stop">
          <Popup>目的地近く: {destStop.stop.name ?? destStop.stop.stop_name ?? destStop.stop.stop_id}</Popup>
        </Marker>
      )}
    </MapContainer>
  );
}
