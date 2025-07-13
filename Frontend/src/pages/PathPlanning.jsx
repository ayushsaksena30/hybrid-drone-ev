/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  MapContainer, TileLayer, Marker, Popup, Polyline, Tooltip,
  LayersControl, ScaleControl, ZoomControl, useMap
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import axios from "axios";
import { Resizable } from "re-resizable";
import React from "react"; // Added for React.Fragment

// Helper functions
function FitBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (points.length > 0) {
      const bounds = L.latLngBounds(points);
      map.fitBounds(bounds, { padding: [60, 60] });
    }
  }, [map, points]);
  return null;
}
function letterIcon(letter, color = "#1976d2") {
  return L.divIcon({
    html: `<div style="
      background:${color};
      color:#fff;
      font-weight:bold;
      border-radius:50%;
      width:32px;height:32px;
      display:flex;align-items:center;justify-content:center;
      border:2px solid #fff;
      box-shadow:0 0 4px #0003;
      font-size:18px;
    ">${letter}</div>`,
    iconSize: [32, 32],
    className: ""
  });
}
const droneIcon = letterIcon("D", "#d32f2f");
const truckIcon = letterIcon("T", "#388e3c");
const hqIcon = letterIcon("A", "#1976d2");
const launchIcon = letterIcon("L", "#ffa000");
const landingIcon = letterIcon("P", "#7b1fa2");

// Use HQ from trip if available, otherwise default
const DEFAULT_HQ = { lat: 12.9716, lng: 77.5946 };
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const OPENWEATHER_API_KEY = import.meta.env.VITE_OPENWEATHER_API_KEY;
console.log("OpenWeather API Key:", OPENWEATHER_API_KEY);

function toRad(x) { return (x * Math.PI) / 180; }
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
function miles(km) { return km * 0.621371; }
function getLabel(idx) {
  return String.fromCharCode(65 + idx);
}
function formatTimeMinutes(minutes) {
  const totalSeconds = Math.round(Number(minutes) * 60);
  if (minutes === undefined || minutes === null || isNaN(totalSeconds) || totalSeconds < 0) return 'N/A';
  
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  let result = '';
  if (hours > 0) {
    result += `${hours} hr `;
  }
  if (mins > 0 || hours > 0) {
    result += `${mins} min `;
  }
  result += `${seconds} sec`;
  
  return result.trim();
}

// Function to get custom display messages for each point type
function getTypeDisplayMessage(type) {
  switch (type) {
    case "HQ":
      return "Headquarters";
    case "Truck":
      return "Truck Delivery";
    case "Launch":
      return "Launch Site";
    case "DroneDelivery":
      return "Drone Delivery";
    case "Landing":
      return "Landing Site";
    default:
      return type;
  }
}

// Nearest Neighbor TSP for truck route optimization
function nearestNeighborRoute(hq, deliveries) {
  const unvisited = deliveries.slice();
  let route = [[hq.lat, hq.lng]];
  let current = { lat: hq.lat, lng: hq.lng };
  while (unvisited.length > 0) {
    let minIdx = 0, minDist = Infinity;
    for (let i = 0; i < unvisited.length; i++) {
      const d = haversineDistance(current.lat, current.lng, Number(unvisited[i].latitude), Number(unvisited[i].longitude));
      if (d < minDist) {
        minDist = d;
        minIdx = i;
      }
    }
    current = {
      lat: Number(unvisited[minIdx].latitude),
      lng: Number(unvisited[minIdx].longitude)
    };
    route.push([current.lat, current.lng]);
    unvisited.splice(minIdx, 1);
  }
  // Remove return route to HQ - only show outbound journey
  return route;
}

// Find the closest point ANYWHERE along the truck route polyline to the drone delivery
function closestPointOnPolyline(polyline, targetLat, targetLng, samplesPerSegment = 50) {
  let minDist = Infinity;
  let bestPoint = null;
  let bestIdx = 0;
  let bestFrac = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const [lat1, lng1] = polyline[i];
    const [lat2, lng2] = polyline[i + 1];
    for (let t = 0; t <= samplesPerSegment; t++) {
      const frac = t / samplesPerSegment;
      const lat = lat1 + (lat2 - lat1) * frac;
      const lng = lng1 + (lng2 - lng1) * frac;
      const dist = haversineDistance(lat, lng, targetLat, targetLng);
      if (dist < minDist) {
        minDist = dist;
        bestPoint = [lat, lng];
        bestIdx = i;
        bestFrac = frac;
      }
    }
  }
  return { point: bestPoint, idx: bestIdx, frac: bestFrac };
}

// Calculate truck distance up to launch (including fractional segment)
function truckDistanceToLaunch(polyline, launchIdx, launchFrac) {
  let dist = 0;
  for (let i = 1; i <= launchIdx; i++) {
    dist += haversineDistance(
      polyline[i - 1][0], polyline[i - 1][1],
      polyline[i][0], polyline[i][1]
    );
  }
  if (launchFrac > 0) {
    const [lat1, lng1] = polyline[launchIdx];
    const [lat2, lng2] = polyline[launchIdx + 1];
    const lat = lat1 + (lat2 - lat1) * launchFrac;
    const lng = lng1 + (lng2 - lng1) * launchFrac;
    dist += haversineDistance(lat1, lng1, lat, lng);
  }
  return dist;
}

// Calculate truck distance after launch (including fractional segment)
function truckDistanceAfterLaunch(polyline, launchIdx, launchFrac) {
  let dist = 0;
  if (launchFrac < 1) {
    const [lat1, lng1] = polyline[launchIdx];
    const [lat2, lng2] = polyline[launchIdx + 1];
    const lat = lat1 + (lat2 - lat1) * launchFrac;
    const lng = lng1 + (lng2 - lng1) * launchFrac;
    dist += haversineDistance(lat, lng, lat2, lng2);
  }
  for (let i = launchIdx + 2; i < polyline.length; i++) {
    dist += haversineDistance(
      polyline[i - 1][0], polyline[i - 1][1],
      polyline[i][0], polyline[i][1]
    );
  }
  return dist;
}

export default function PathPlanning() {
  const [trip, setTrip] = useState(null);
  const [truckPolyline, setTruckPolyline] = useState([]);
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [routeError, setRouteError] = useState(null);
  const [mapSize, setMapSize] = useState({ width: 700, height: 450 });
  const [windSpeed, setWindSpeed] = useState(null);
  const [windLoading, setWindLoading] = useState(false);
  const [windError, setWindError] = useState(null);
  const [xgbResult, setXgbResult] = useState(null);

  // Use HQ from trip if available
  const HQ = trip && trip.hqLat && trip.hqLng ? { lat: Number(trip.hqLat), lng: Number(trip.hqLng) } : DEFAULT_HQ;

  const navigate = useNavigate();

  useEffect(() => {
  const storedTrip = localStorage.getItem("latestTrip");
  if (storedTrip) {
    const parsedTrip = JSON.parse(storedTrip);
    console.log("Loaded trip from localStorage:", parsedTrip);
    setTrip(parsedTrip);
  } else {
      console.log("No trip found in localStorage, redirecting to newtrip");
      navigate("/newtrip");
  }
}, []);

  useEffect(() => {
    const result = localStorage.getItem("xgbResult");
    console.log("Raw xgbResult from localStorage:", result);
    if (result && result !== "undefined") {
      try {
        const parsedResult = JSON.parse(result);
        console.log("Parsed xgbResult:", parsedResult);
        setXgbResult(parsedResult);
      } catch (e) {
        console.error("Failed to parse xgbResult:", e);
        setXgbResult(null);
      }
    } else {
      console.log("No xgbResult found in localStorage");
      setXgbResult(null);
    }
  }, []);

  let droneDelivery = null;
  let truckDeliveries = [];
  let drone = null;
  let optimizedNodeOrder = [[HQ.lat, HQ.lng], [HQ.lat, HQ.lng]];
  let mlPredictedIndex = null;
  let mlPredictedDelivery = null;
  if (trip) {
    mlPredictedIndex = trip.mlPredictedIndex;
    mlPredictedDelivery = trip.mlPredictedDelivery;
    droneDelivery = mlPredictedDelivery
      ? {
          ...mlPredictedDelivery,
          latitude: Number(mlPredictedDelivery.latitude),
          longitude: Number(mlPredictedDelivery.longitude)
        }
      : (trip.droneDelivery
        ? {
            ...trip.droneDelivery,
            latitude: Number(trip.droneDelivery.latitude),
            longitude: Number(trip.droneDelivery.longitude)
          }
        : null);
    truckDeliveries = (trip.truckDeliveries || []).map(del => ({
      ...del,
      latitude: Number(del.latitude),
      longitude: Number(del.longitude)
    }));
    drone = trip.drone;
    optimizedNodeOrder = nearestNeighborRoute(HQ, truckDeliveries);
  }

  // Fetch Mapbox Route Polyline for Truck
  useEffect(() => {
    async function fetchRoute() {
      setLoadingRoute(true);
      setRouteError(null);
      try {
        if (!MAPBOX_TOKEN) throw new Error("Mapbox token missing");
        const coordsStr = optimizedNodeOrder
          .map(([lat, lng]) => `${lng},${lat}`)
          .join(';');
        const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coordsStr}?geometries=geojson&access_token=${MAPBOX_TOKEN}`;
        const res = await axios.get(url);
        if (!res.data.routes || !res.data.routes[0]) throw new Error("No route found");
        const geometry = res.data.routes[0].geometry.coordinates;
        setTruckPolyline(geometry.map(([lng, lat]) => [lat, lng]));
      } catch (err) {
        setRouteError("Failed to fetch truck route. Showing straight lines instead.");
        setTruckPolyline([]);
      }
      setLoadingRoute(false);
    }
    if (optimizedNodeOrder.length > 1 && MAPBOX_TOKEN) fetchRoute();
  }, [JSON.stringify(optimizedNodeOrder), MAPBOX_TOKEN]);

  // --- TRUE HYBRID LAUNCH/LAND LOGIC ---
  const { point: launchPoint, idx: launchIdx, frac: launchFrac } = closestPointOnPolyline(
    truckPolyline.length > 1 ? truckPolyline : optimizedNodeOrder,
    droneDelivery?.latitude,
    droneDelivery?.longitude,
    50 // high precision
  );
  const landingPoint = launchPoint;

  // Build traversalPoints so that step letters always match the true traversal order
  let traversalPoints = [];
  // Find the closest segment index for launch point
  let insertIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < optimizedNodeOrder.length - 1; i++) {
    const [lat1, lng1] = optimizedNodeOrder[i];
    const [lat2, lng2] = optimizedNodeOrder[i + 1];
    if (!launchPoint || launchPoint[0] == null || launchPoint[1] == null) continue;
    // Distance from launchPoint to segment midpoint
    const midLat = (lat1 + lat2) / 2;
    const midLng = (lng1 + lng2) / 2;
    const dist = haversineDistance(launchPoint[0], launchPoint[1], midLat, midLng);
    if (dist < minDist) {
      minDist = dist;
      insertIdx = i + 1;
    }
  }
  // Walk through the route up to insertIdx
  for (let i = 0; i < insertIdx; i++) {
    if (i === 0) {
      traversalPoints.push({ type: "HQ", coords: optimizedNodeOrder[i] });
    } else {
      traversalPoints.push({ type: "Truck", coords: optimizedNodeOrder[i] });
    }
  }
  // Insert drone segment
  if (launchPoint && launchPoint[0] != null && launchPoint[1] != null) {
    traversalPoints.push({ type: "Launch", coords: launchPoint });
    traversalPoints.push({ type: "DroneDelivery", coords: droneDelivery && droneDelivery.latitude != null && droneDelivery.longitude != null ? [droneDelivery.latitude, droneDelivery.longitude] : [null, null] });
    traversalPoints.push({ type: "Landing", coords: launchPoint });
  }
  // Continue with the rest of the route
  for (let i = insertIdx; i < optimizedNodeOrder.length; i++) {
    traversalPoints.push({ type: "Truck", coords: optimizedNodeOrder[i] });
  }
  // Assign step letters strictly in traversal order
  traversalPoints = traversalPoints.map((pt, idx) => ({ ...pt, label: String.fromCharCode(65 + idx) }));
  // No return to HQ - trip ends at last delivery
  const allPoints = traversalPoints.map(pt => pt.coords);

  // Calculate time between each stop
  function getSegmentTime(ptA, ptB, typeA, typeB) {
    if (!ptA || !ptB || ptA[0] == null || ptA[1] == null || ptB[0] == null || ptB[1] == null) return NaN;
    const [latA, lngA] = ptA;
    const [latB, lngB] = ptB;
    const dist = haversineDistance(latA, lngA, latB, lngB);
    
    // Use ML time (predicted_time_minutes or time) for drone segments
    const mlMinutes = xgbResult && (xgbResult.predicted_time_minutes ?? xgbResult.time);
    
    // Drone segments (Launch to Delivery, Delivery to Landing)
    if ((typeA === "Launch" && typeB === "DroneDelivery") || 
        (typeA === "DroneDelivery" && typeB === "Landing")) {
      if (mlMinutes) {
        // For drone segments, use ML prediction directly
        return Number(mlMinutes);
      }
      // Fallback: calculate based on drone speed (40 km/h) and distance
      return (dist / 40) * 60; // minutes
    }
    
    // Truck segments (HQ to Truck deliveries, Truck to Truck, Truck to Launch)
    if (typeA === "HQ" || typeB === "HQ" || 
        (typeA === "Truck" && typeB === "Truck") ||
        (typeA === "Truck" && typeB === "Launch") ||
        (typeA === "Launch" && typeB === "Truck")) {
      // Truck speed: 30 km/h in city traffic
      return (dist / 30) * 60; // minutes
    }
    
    // Landing to next truck delivery (if any)
    if (typeA === "Landing" && typeB === "Truck") {
      return (dist / 30) * 60; // minutes
    }
    
    // Default fallback
    return (dist / 30) * 60; // minutes
  }

  // Wind speed fetch
  useEffect(() => {
    const fetchWind = async () => {
      if (launchPoint && droneDelivery) {
        setWindLoading(true);
        setWindError(null);
        setWindSpeed(null);
        try {
          const lat1 = launchPoint[0];
          const lng1 = launchPoint[1];
          const lat2 = droneDelivery.latitude;
          const lng2 = droneDelivery.longitude;
          const midLat = (lat1 + lat2) / 2;
          const midLng = (lng1 + lng2) / 2;
          const url = `https://api.openweathermap.org/data/2.5/weather?lat=${midLat}&lon=${midLng}&appid=${OPENWEATHER_API_KEY}&units=metric`;
          const res = await fetch(url);
          const data = await res.json();
          const wind = data.wind && data.wind.speed ? data.wind.speed : null;
          setWindSpeed(wind);
          if (wind !== null && !isNaN(wind)) {
            localStorage.setItem('windSpeed', wind);
          }
        } catch (err) {
          setWindError('Failed to fetch wind speed');
        } finally {
          setWindLoading(false);
        }
      }
    };
    fetchWind();
  }, [launchPoint && droneDelivery && `${launchPoint[0]},${launchPoint[1]},${droneDelivery.latitude},${droneDelivery.longitude}`]);

  if (!trip || !droneDelivery) return <div style={{padding: 40}}>Loading trip...</div>;

  const polyline = truckPolyline.length > 1 ? truckPolyline : optimizedNodeOrder;
  const truckDistToLaunch = truckDistanceToLaunch(polyline, launchIdx, launchFrac);
  const truckTimeToLaunch = (truckDistToLaunch / 30) * 60;

  const truckDistAfter = truckDistanceAfterLaunch(polyline, launchIdx, launchFrac);
  const truckTimeAfter = (truckDistAfter / 30) * 60;

  const droneLeg = haversineDistance(
    launchPoint[0], launchPoint[1],
    droneDelivery.latitude, droneDelivery.longitude
  );
  
  // Use ML predicted time if available, otherwise calculate based on distance
  const droneTripTime = xgbResult && xgbResult.predicted_time_minutes ? Number(xgbResult.predicted_time_minutes) : (2 * droneLeg / 40) * 60;

  const totalTripTime = truckTimeToLaunch + Math.max(droneTripTime, truckTimeAfter);

  // --- Carbon Emission Calculation (Corrected) ---
  const TRUCK_EMISSION_PER_KM = 1.746; // kg CO2/km
  const DRONE_EMISSION_PER_KM = 0.002; // kg CO2/km

  // Calculate the actual distances for both scenarios
  const droneDeliveryDistance = haversineDistance(launchPoint[0], launchPoint[1], droneDelivery.latitude, droneDelivery.longitude);
  
  // Scenario 1: Truck-only (all deliveries by truck)
  // Calculate total truck distance for all deliveries including the drone delivery
  let truckOnlyTotalDistance = 0;
  let prevPoint = HQ;
  
  // Add distance to all truck deliveries
  truckDeliveries.forEach(del => {
    const dist = haversineDistance(prevPoint.lat, prevPoint.lng, del.latitude, del.longitude);
    truckOnlyTotalDistance += dist;
    prevPoint = { lat: del.latitude, lng: del.longitude };
  });
  
  // Add distance to drone delivery location
  truckOnlyTotalDistance += haversineDistance(prevPoint.lat, prevPoint.lng, droneDelivery.latitude, droneDelivery.longitude);
  
  const truckOnlyCarbon = truckOnlyTotalDistance * TRUCK_EMISSION_PER_KM;

  // Scenario 2: Hybrid (truck delivers other packages, drone delivers this package)
  // Calculate truck distance (excluding drone delivery location)
  let hybridTruckDistance = 0;
  prevPoint = HQ;
  
  // Add distance to truck deliveries only
  truckDeliveries.forEach(del => {
    const dist = haversineDistance(prevPoint.lat, prevPoint.lng, del.latitude, del.longitude);
    hybridTruckDistance += dist;
    prevPoint = { lat: del.latitude, lng: del.longitude };
  });
  
  // Add distance from last truck delivery to launch point
  hybridTruckDistance += haversineDistance(prevPoint.lat, prevPoint.lng, launchPoint[0], launchPoint[1]);
  
  // Add distance from landing point to next truck delivery (if any)
  if (launchIdx < truckDeliveries.length) {
    hybridTruckDistance += haversineDistance(launchPoint[0], launchPoint[1], truckDeliveries[launchIdx].latitude, truckDeliveries[launchIdx].longitude);
  }
  
  const hybridTruckCarbon = hybridTruckDistance * TRUCK_EMISSION_PER_KM;
  const hybridDroneCarbon = droneDeliveryDistance * DRONE_EMISSION_PER_KM;
  const hybridCarbon = hybridTruckCarbon + hybridDroneCarbon;

  // Carbon reduction = (truck-only - hybrid) / truck-only * 100
  const carbonReduction = truckOnlyCarbon > 0 ? ((truckOnlyCarbon - hybridCarbon) / truckOnlyCarbon) * 100 : 0;
  
  // Carbon emission saved = truck-only - hybrid
  const carbonEmission = truckOnlyCarbon - hybridCarbon;

  // Calculate truck-only total time (all deliveries by truck, in optimized order)
  let truckOnlyTotalTime = 0;
  if (optimizedNodeOrder.length > 1) {
    for (let i = 1; i < optimizedNodeOrder.length; i++) {
      const [latA, lngA] = optimizedNodeOrder[i - 1];
      const [latB, lngB] = optimizedNodeOrder[i];
      const dist = haversineDistance(latA, lngA, latB, lngB);
      truckOnlyTotalTime += (dist / 30) * 60; // 30 km/h truck speed
    }
  }
  const timeSaved = truckOnlyTotalTime - totalTripTime;

  return (
    <div style={{
      display: "flex",
      flexDirection: "row",
      height: "100vh",
      width: "100vw",
      fontFamily: "Inter, Roboto, Arial, sans-serif",
      overflowX: "hidden" // Hide horizontal scrollbar
    }}>
      {/* Sidebar */}
      <div style={{
        width: 400,
        minWidth: 320,
        maxWidth: 500,
        background: "#fff",
        boxShadow: "2px 0 12px #0001",
        padding: "36px 24px 36px 32px",
        overflowY: "visible",
        overflowX: "hidden" // Hide horizontal scrollbar in sidebar
      }}>
        <h2 style={{marginBottom: 12, color: "#1976d2", letterSpacing: 1}}>Trip Details</h2>
        <div style={{
          background: "#f1f8e9",
          borderRadius: 12,
          padding: "16px 20px",
          marginBottom: 18,
          boxShadow: "0 2px 8px #0001"
        }}>
          <div style={{fontWeight: 600, fontSize: "1.1em", marginBottom: 4}}>Carbon Emission Reduction</div>
          <div style={{
            fontSize: "2em",
            fontWeight: 700,
            color: "#43a047",
            marginBottom: 4
          }}>{carbonReduction.toFixed(1)}%</div>
          <div style={{ fontSize: "0.97em", color: "#666" }}>
            <span style={{marginRight: 16}}>
              <span style={{fontWeight: 500}}>Carbon Emission Reduced: </span>
              {carbonEmission.toFixed(2)} kg CO₂
            </span>
          </div>
        </div>
        <div style={{
          background: "#e3f2fd",
          borderRadius: 12,
          padding: "16px 20px",
          marginBottom: 18,
          boxShadow: "0 2px 8px #0001"
        }}>
          <div style={{fontWeight: 600, fontSize: "1.1em", marginBottom: 4}}>
            Estimated Total Time
            {xgbResult && xgbResult.time && <span style={{ fontSize: 14, marginLeft: 8, color: "#d32f2f" }}></span>}
          </div>
          <div style={{
            fontSize: "2em",
            fontWeight: 700,
            color: xgbResult && xgbResult.time ? "#d32f2f" : "#1976d2"
          }}>{formatTimeMinutes(totalTripTime)}</div>
          <div style={{ fontSize: "1em", color: "#1976d2", marginTop: 6 }}>
          </div>
        </div>
        
        {mlPredictedDelivery && xgbResult && (
          <div style={{
            background: "#fff3e0",
            borderRadius: 12,
            padding: "16px 20px",
            marginBottom: 18,
            boxShadow: "0 2px 8px #0001",
            border: "2px solid #ff9800"
          }}>
            <div style={{fontWeight: 600, fontSize: "1.1em", marginBottom: 4, color: "#e65100"}}>
              Drone Delivery Prediction
            </div>
            <div style={{fontSize: "1em", color: "#666"}}>
              <div style={{marginBottom: 8}}>
                <strong style={{color: "#e65100"}}>Location:</strong> ({mlPredictedDelivery.latitude}, {mlPredictedDelivery.longitude})
              </div>
              <div style={{marginBottom: 8}}>
                <strong style={{color: "#e65100"}}>Drone ID:</strong> {xgbResult.drone && xgbResult.drone.drone_id ? xgbResult.drone.drone_id : (xgbResult.droneId || 'N/A')}
              </div>
              <div>
                <strong style={{color: "#e65100"}}>Predicted Time:</strong> {xgbResult.predicted_time_minutes ? Number(xgbResult.predicted_time_minutes).toFixed(2) : (xgbResult.time ? Number(xgbResult.time).toFixed(2) : 'N/A')} min
              </div>
            </div>
          </div>
        )}
        {!mlPredictedDelivery && (
          <div style={{background: "#ffeaea", borderRadius: 12, padding: "16px 20px", marginBottom: 18, border: "2px solid #e57373"}}>
            <div style={{fontWeight: 600, color: "#d32f2f"}}>No ML Prediction</div>
            <div style={{color: "#888"}}>Fallback logic was used for drone delivery selection.</div>
          </div>
        )}
        <div style={{
          background: "#f6f8fa",
          borderRadius: 12,
          padding: "18px 22px",
          marginBottom: 18,
          boxShadow: "0 2px 8px #0001"
        }}>
          <div style={{fontWeight: 600, fontSize: "1.1em", marginBottom: 6}}>Traversal Order</div>
          <div style={{display: "flex", flexDirection: "column", gap: 0}}>
            {traversalPoints.map((pt, idx) => (
              <React.Fragment key={idx}>
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  background: "#e3eafc",
                  borderRadius: 8,
                  padding: "8px 16px",
                  margin: "0 0 0 0",
                  fontWeight: 500,
                  color: pt.type === "HQ" ? "#1976d2" : pt.type === "Truck" ? "#388e3c" : pt.type === "Launch" ? "#ffa000" : pt.type === "DroneDelivery" ? "#d32f2f" : pt.type === "Landing" ? "#7b1fa2" : "#1976d2",
                  fontSize: "1.08em",
                  boxShadow: idx === 0 ? "0 2px 8px #1976d222" : undefined
                }}>
                  <span style={{
                    display: "inline-block",
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background: pt.type === "HQ" ? "#1976d2" : pt.type === "Truck" ? "#388e3c" : pt.type === "Launch" ? "#ffa000" : pt.type === "DroneDelivery" ? "#d32f2f" : pt.type === "Landing" ? "#7b1fa2" : "#1976d2",
                    color: "#fff",
                    fontWeight: 700,
                    textAlign: "center",
                    lineHeight: "22px",
                    marginRight: 10
                  }}>{pt.label}</span>
                  {getTypeDisplayMessage(pt.type)}
                </div>
                {/* Arrow and time to next stop */}
                {idx < traversalPoints.length - 1 && (
                  <div style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    margin: "0 0 0 18px"
                  }}>
                    <span style={{ fontSize: 22, color: "#b3b3b3", margin: "2px 0" }}>↓</span>
                    <span style={{ fontSize: 13, color: "#1976d2", fontWeight: 500, marginBottom: 2 }}>
                      {(() => {
                        const t = getSegmentTime(
                          traversalPoints[idx].coords,
                          traversalPoints[idx + 1].coords,
                          traversalPoints[idx].type,
                          traversalPoints[idx + 1].type
                        );
                        const isDroneSegment = (traversalPoints[idx].type === "Launch" && traversalPoints[idx + 1].type === "DroneDelivery") ||
                                             (traversalPoints[idx].type === "DroneDelivery" && traversalPoints[idx + 1].type === "Landing");
                        const isMLPrediction = isDroneSegment && xgbResult && xgbResult.predicted_time_minutes;
                        return isNaN(t) ? "" : (
                          <span style={{ color: isMLPrediction ? "#d32f2f" : "#1976d2", fontWeight: isMLPrediction ? 700 : 500, fontSize: isMLPrediction ? 16 : 12 }} title={isMLPrediction ? "ML Predicted Time" : undefined}>
                            {formatTimeMinutes(t)}
                            {isMLPrediction && <span style={{ fontSize: 12, marginLeft: 4 }}>🧠</span>}
                          </span>
                        );
                      })()}
                    </span>
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
        <div style={{
          background: "#fff",
          borderRadius: 12,
          padding: "18px 22px",
          marginBottom: 18,
          boxShadow: "0 2px 8px #0001"
        }}>
          <div style={{fontWeight: 600, fontSize: "1.1em", marginBottom: 6}}>Locations</div>
          <table style={{width: "100%", fontSize: "1em", borderCollapse: "collapse"}}>
            <tbody>
              {traversalPoints.filter(pt => pt.coords && pt.coords.length === 2).map(pt => (
                <tr key={pt.label}>
                  <td style={{
                    fontWeight: 500,
                    color:
                      pt.type === "HQ" ? "#1976d2" :
                      pt.type === "Truck" ? "#388e3c" :
                      pt.type === "Launch" ? "#ffa000" :
                      pt.type === "DroneDelivery" ? "#d32f2f" :
                      pt.type === "Landing" ? "#7b1fa2" : "#1976d2"
                  }}>{pt.label} ({pt.type}):</td>
                  <td>{pt.coords && pt.coords[0] != null && pt.coords[1] != null ? `${pt.coords[0]}, ${pt.coords[1]}` : "N/A"}</td>
                </tr>
              ))}
            </tbody>
          </table>
            </div>
     
        <div style={{marginTop: 8}}>
          <b>Average Wind Speed (drone route):</b>
          {windLoading && <span style={{color: '#888'}}> Loading...</span>}
          {windError && <span style={{color: 'red'}}> {windError}</span>}
          {windSpeed !== null && !windLoading && !windError && (
            <span style={{color: '#0077b6'}}> {windSpeed} m/s</span>
          )}
        </div>
        {/* Action Buttons */}
        <div style={{
          display: "flex",
          gap: 16,
          marginTop: 32,
          justifyContent: "flex-end"
        }}>
          <button
  style={{
    background: "#1976d2",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 28px",
    fontWeight: 600,
    fontSize: "1.1em",
    cursor: "pointer",
    boxShadow: "0 2px 8px #1976d222",
    transition: "background 0.2s"
  }}
  onClick={async () => {
    try {
      await axios.post('/api/trips/createTrip', trip);

      if (trip.drone) {
        trip.drone.available = false;
      }

      // Add calculated stats to trip before saving
      trip.carbonReduction = carbonReduction;
      trip.carbonEmission = carbonEmission;
      trip.totalTripTime = totalTripTime;
      trip.truckOnlyTotalTime = truckOnlyTotalTime;
      trip.timeSaved = timeSaved;
      // Save ML-suggested drone id if available
      if (xgbResult && (xgbResult.drone_id || (xgbResult.drone && xgbResult.drone.drone_id))) {
        trip.mlDroneId = xgbResult.drone_id || (xgbResult.drone && xgbResult.drone.drone_id);
      }

      let dronesList = JSON.parse(localStorage.getItem("dronesList") || "[]");
      if (trip.drone) {
        dronesList = dronesList.map(d =>
          d.droneId === trip.drone.droneId ? { ...d, available: false } : d
        );
        localStorage.setItem("dronesList", JSON.stringify(dronesList));
      }

      const allTrips = JSON.parse(localStorage.getItem("allTrips") || "[]");
      allTrips.push(trip);
      localStorage.setItem("allTrips", JSON.stringify(allTrips));
      localStorage.removeItem("latestTrip");
      navigate("/tripresults");
    } catch (error) {
      alert("Error: Failed to execute trip.");
    }
  }}
>
  Execute Delivery
</button>

         <button
  style={{
    background: "#fff",
    color: "#1976d2",
    border: "2px solid #1976d2",
    borderRadius: 8,
    padding: "12px 28px",
    fontWeight: 600,
    fontSize: "1.1em",
    cursor: "pointer",
    boxShadow: "0 2px 8px #1976d222",
    transition: "background 0.2s"
  }}
  onClick={() => {
    localStorage.setItem("editTrip", JSON.stringify(trip));
    navigate("/newtrip");
  }}
>
  Edit Delivery
</button>
        </div>
      </div>

      {/* Map */}
      <div style={{
        flex: 1,
        position: "relative",
        overflowX: "hidden"
      }}>
        {routeError && <div style={{position:"absolute",top:10,left:10,color:"red",zIndex:999}}>{routeError}</div>}
        <MapContainer
          style={{ width: "100%", height: "100%" }}
          zoom={11}
          center={allPoints[0]}
          scrollWheelZoom={true}
          zoomControl={false}
        >
          <LayersControl position="topright">
            <LayersControl.BaseLayer checked name="OpenStreetMap">
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; OpenStreetMap contributors' />
            </LayersControl.BaseLayer>
            <LayersControl.BaseLayer name="Mapbox Streets">
              <TileLayer
                url={`https://api.mapbox.com/styles/v1/mapbox/streets-v11/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`}
                attribution='&copy; Mapbox &copy; OpenStreetMap contributors'
                tileSize={512}
                zoomOffset={-1}
              />
            </LayersControl.BaseLayer>
          </LayersControl>
          <ZoomControl position="topright" />
          <ScaleControl position="bottomleft" />
          <FitBounds points={allPoints} />
          {/* Lettered markers for traversal order (A, B, C, ...) - show both step letters if two steps share the same coordinates */}
          {traversalPoints.map((pt, idx) => {
            // Find all steps at this coordinate
            const sameCoordIndices = traversalPoints
              .map((p, i) => (p.coords[0] === pt.coords[0] && p.coords[1] === pt.coords[1] ? i : null))
              .filter(i => i !== null);
            // Only render marker for the first occurrence of this coordinate
            if (sameCoordIndices[0] !== idx) return null;
            // Collect all step letters at this coordinate
            const stepLetters = sameCoordIndices.map(i => String.fromCharCode(65 + i)).join(', ');
            // Compose marker
            return (
              <Marker
                key={idx}
                position={pt.coords}
                icon={L.divIcon({
                  html: `<div style="
                    background: ${pt.type === 'HQ' ? '#1976d2' : pt.type === 'Truck' ? '#388e3c' : pt.type === 'Launch' ? '#ffa000' : pt.type === 'DroneDelivery' ? '#d32f2f' : pt.type === 'Landing' ? '#7b1fa2' : '#1976d2'};
                    color: #fff;
                    font-weight: bold;
                    border-radius: 50%;
                    width: 38px; height: 38px;
                    display: flex; align-items: center; justify-content: center;
                    border: 2px solid #fff;
                    box-shadow: 0 0 4px #0003;
                    font-size: 16px;">
                    ${stepLetters}
                  </div>`,
                  iconSize: [38, 38],
                  className: ''
                })}
              >
                <Tooltip direction="top" offset={[0, -10]} opacity={1}>
                  <span style={{ fontWeight: "bold", fontSize: 15 }}>{stepLetters} - {pt.type}</span>
                </Tooltip>
                <Popup>
                  <b>{pt.label}</b> - {pt.type}
                  <br />
                  <span style={{ fontSize: 13, color: "#333" }}>
                    {pt.coords[0].toFixed(5)}, {pt.coords[1].toFixed(5)}
                  </span>
                  {pt.type === "DroneDelivery" && trip.drone && (
                    <div>Drone ID Used: <b>{trip.drone.droneId}</b></div>
                  )}
                </Popup>
              </Marker>
            );
          })}
          {polyline.length > 1 && (
            <Polyline positions={polyline} color="#1976d2" weight={6} opacity={0.8} />
          )}
          {launchPoint && (
            <>
              <Polyline
                positions={[
                  launchPoint,
                  [droneDelivery.latitude, droneDelivery.longitude],
                  landingPoint
                ]}
                color="#d32f2f"
                weight={4}
                opacity={0.9}
                dashArray="12, 10"
              />
              
              {/* Time annotations for drone route */}
              {xgbResult && xgbResult.predicted_time_minutes && (
                <>
                  {/* Launch to Delivery time annotation */}
                  <Marker
                    position={[
                      (launchPoint[0] + droneDelivery.latitude) / 2,
                      (launchPoint[1] + droneDelivery.longitude) / 2
                    ]}
                    icon={L.divIcon({
                      html: `<div style="
                        background: #d32f2f;
                        color: white;
                        padding: 4px 8px;
                        border-radius: 12px;
                        font-size: 11px;
                        font-weight: bold;
                        border: 2px solid white;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
                        white-space: nowrap;
                      ">${(Number(xgbResult.predicted_time_minutes) / 2).toFixed(0)} min</div>`,
                      iconSize: [60, 20],
                      className: ""
                    })}
                  />
                  
                  {/* Delivery to Landing time annotation */}
                  <Marker
                    position={[
                      (droneDelivery.latitude + landingPoint[0]) / 2,
                      (droneDelivery.longitude + landingPoint[1]) / 2
                    ]}
                    icon={L.divIcon({
                      html: `<div style="
                        background: #d32f2f;
                        color: white;
                        padding: 4px 8px;
                        border-radius: 12px;
                        font-size: 11px;
                        font-weight: bold;
                        border: 2px solid white;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
                        white-space: nowrap;
                      ">${(Number(xgbResult.predicted_time_minutes) / 2).toFixed(0)} min</div>`,
                      iconSize: [60, 20],
                      className: ""
                    })}
                  />
                </>
              )}
            </>
          )}
        </MapContainer>
      </div>
    </div>
  );
}
