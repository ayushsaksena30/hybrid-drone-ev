/* eslint-disable no-unused-vars */
import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import axios from "axios";
import "../TripResults.css";
import L from "leaflet";

// Use HQ from trip if available, otherwise default
const DEFAULT_HQ = { lat: 12.9716, lng: 77.5946 };

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

function calcDroneTime(distanceKm, payloadKg) {
  const speed = 40; // km/h
  const baseTime = (distanceKm / speed) * 60; // min
  const penalty = Math.ceil(payloadKg / 2); // 1 min per 2kg
  return baseTime + penalty;
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const toRad = (x) => (x * Math.PI) / 180;
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

// Helper to calculate carbon reduction and estimated time for a trip
function calculateTripStats(trip, xgbResult) {
  if (!trip) return { carbonReduction: 0, totalTripTime: 0 };
  const HQ = trip.hqLat && trip.hqLng ? { lat: Number(trip.hqLat), lng: Number(trip.hqLng) } : DEFAULT_HQ;
  const truckDeliveries = (trip.truckDeliveries || []).map(del => ({
    ...del,
    latitude: Number(del.latitude),
    longitude: Number(del.longitude)
  }));
  const droneDelivery = trip.mlPredictedDelivery
    ? {
        ...trip.mlPredictedDelivery,
        latitude: Number(trip.mlPredictedDelivery.latitude),
        longitude: Number(trip.mlPredictedDelivery.longitude)
      }
    : (trip.droneDelivery
      ? {
          ...trip.droneDelivery,
          latitude: Number(trip.droneDelivery.latitude),
          longitude: Number(trip.droneDelivery.longitude)
        }
      : null);
  if (!droneDelivery) return { carbonReduction: 0, totalTripTime: 0 };
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
    return route;
  }
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
  const optimizedNodeOrder = nearestNeighborRoute(HQ, truckDeliveries);
  const closestResult = droneDelivery ? closestPointOnPolyline(
    optimizedNodeOrder,
    droneDelivery.latitude,
    droneDelivery.longitude,
    50
  ) : { point: null, idx: 0, frac: 0 };
  const launchPoint = closestResult.point;
  const launchIdx = closestResult.idx;
  const launchFrac = closestResult.frac;
  // Find launchInsertIdx
  const userTrip = [HQ, ...truckDeliveries, HQ];
  let launchInsertIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < userTrip.length - 1; i++) {
    const [lat1, lng1] = [userTrip[i].latitude || userTrip[i].lat, userTrip[i].longitude || userTrip[i].lng];
    const [lat2, lng2] = [userTrip[i+1].latitude || userTrip[i+1].lat, userTrip[i+1].longitude || userTrip[i+1].lng];
    if (!launchPoint || launchPoint[0] == null || launchPoint[1] == null) continue;
    const dist = haversineDistance(launchPoint[0], launchPoint[1], lat1, lng1) + haversineDistance(launchPoint[0], launchPoint[1], lat2, lng2);
    if (dist < minDist) {
      minDist = dist;
      launchInsertIdx = i + 1;
    }
  }
  // Defensive: if launchPoint or droneDelivery is missing, return default
  if (!droneDelivery || !launchPoint || launchPoint[0] == null || launchPoint[1] == null) {
    return { carbonReduction: 0, totalTripTime: 0 };
  }
  const TRUCK_EMISSION_PER_KM = 0.746;
  const DRONE_EMISSION_PER_KM = 0.062;
  const droneDeliveryDistance = haversineDistance(launchPoint[0], launchPoint[1], droneDelivery.latitude, droneDelivery.longitude);
  let truckOnlyTotalDistance = 0;
  let prevPoint = HQ;
  truckDeliveries.forEach(del => {
    const dist = haversineDistance(prevPoint.lat, prevPoint.lng, del.latitude, del.longitude);
    truckOnlyTotalDistance += dist;
    prevPoint = { lat: del.latitude, lng: del.longitude };
  });
  truckOnlyTotalDistance += haversineDistance(prevPoint.lat, prevPoint.lng, droneDelivery.latitude, droneDelivery.longitude);
  const truckOnlyCarbon = truckOnlyTotalDistance * TRUCK_EMISSION_PER_KM;
  let hybridTruckDistance = 0;
  prevPoint = HQ;
  truckDeliveries.forEach(del => {
    const dist = haversineDistance(prevPoint.lat, prevPoint.lng, del.latitude, del.longitude);
    hybridTruckDistance += dist;
    prevPoint = { lat: del.latitude, lng: del.longitude };
  });
  hybridTruckDistance += haversineDistance(prevPoint.lat, prevPoint.lng, launchPoint[0], launchPoint[1]);
  if (launchInsertIdx < truckDeliveries.length) {
    hybridTruckDistance += haversineDistance(launchPoint[0], launchPoint[1], truckDeliveries[launchInsertIdx].latitude, truckDeliveries[launchInsertIdx].longitude);
  }
  const hybridTruckCarbon = hybridTruckDistance * TRUCK_EMISSION_PER_KM;
  const hybridDroneCarbon = droneDeliveryDistance * DRONE_EMISSION_PER_KM;
  const hybridCarbon = hybridTruckCarbon + hybridDroneCarbon;
  const carbonReduction = truckOnlyCarbon > 0 ? ((truckOnlyCarbon - hybridCarbon) / truckOnlyCarbon) * 100 : 0;
  // --- Estimated Time Calculation ---
  function getSegmentTime(ptA, ptB, typeA, typeB) {
    if (!ptA || !ptB || ptA[0] == null || ptA[1] == null || ptB[0] == null || ptB[1] == null) return NaN;
    const [latA, lngA] = ptA;
    const [latB, lngB] = ptB;
    const dist = haversineDistance(latA, lngA, latB, lngB);
    const mlMinutes = xgbResult && (xgbResult.predicted_time_minutes ?? xgbResult.time);
    if ((typeA === "Launch" && typeB === "DroneDelivery") || 
        (typeA === "DroneDelivery" && typeB === "Landing")) {
      if (mlMinutes) {
        return Number(mlMinutes);
      }
      return (dist / 40) * 60;
    }
    if (typeA === "HQ" || typeB === "HQ" || 
        (typeA === "Truck" && typeB === "Truck") ||
        (typeA === "Truck" && typeB === "Launch") ||
        (typeA === "Launch" && typeB === "Truck")) {
      return (dist / 30) * 60;
    }
    if (typeA === "Landing" && typeB === "Truck") {
      return (dist / 30) * 60;
    }
    return (dist / 30) * 60;
  }
  let traversalPoints = [];
  if (HQ.lat != null && HQ.lng != null) {
    traversalPoints.push({ label: String.fromCharCode(65), type: "HQ", coords: [HQ.lat, HQ.lng] });
  }
  for (let i = 0; i < launchInsertIdx; i++) {
    if (truckDeliveries[i] && truckDeliveries[i].latitude != null && truckDeliveries[i].longitude != null) {
      traversalPoints.push({ label: String.fromCharCode(65 + i + 1), type: "Truck", coords: [truckDeliveries[i].latitude, truckDeliveries[i].longitude] });
    }
  }
  if (launchPoint && launchPoint[0] != null && launchPoint[1] != null) {
    traversalPoints.push({ label: String.fromCharCode(65 + launchInsertIdx + 1), type: "Launch", coords: launchPoint });
  }
  if (droneDelivery && droneDelivery.latitude != null && droneDelivery.longitude != null) {
    traversalPoints.push({ label: String.fromCharCode(65 + launchInsertIdx + 2), type: "DroneDelivery", coords: [droneDelivery.latitude, droneDelivery.longitude] });
  }
  if (launchPoint && launchPoint[0] != null && launchPoint[1] != null) {
    traversalPoints.push({ label: String.fromCharCode(65 + launchInsertIdx + 3), type: "Landing", coords: launchPoint });
  }
  for (let i = launchInsertIdx; i < truckDeliveries.length; i++) {
    if (truckDeliveries[i] && truckDeliveries[i].latitude != null && truckDeliveries[i].longitude != null) {
      traversalPoints.push({ label: String.fromCharCode(65 + launchInsertIdx + 4 + (i - launchInsertIdx)), type: "Truck", coords: [truckDeliveries[i].latitude, truckDeliveries[i].longitude] });
    }
  }
  const totalTripTime = traversalPoints.slice(0, -1).reduce((sum, pt, idx) => {
    return sum + getSegmentTime(
      traversalPoints[idx].coords,
      traversalPoints[idx + 1].coords,
      traversalPoints[idx].type,
      traversalPoints[idx + 1].type
    );
  }, 0);
  return { carbonReduction, totalTripTime };
}

export default function TripResults() {
  const [trips, setTrips] = useState([]);
  const [selected, setSelected] = useState(0);
  const [truckRoute, setTruckRoute] = useState({ distance: null, duration: null, loading: false, error: null });
  const [droneTime, setDroneTime] = useState(null);
  const [truckTime, setTruckTime] = useState(null);
  const [toggleLoading, setToggleLoading] = useState(false);
  const [finishedDeliveries, setFinishedDeliveries] = useState(new Set()); // Track finished deliveries
  const [xgbResult, setXgbResult] = useState(null); // Add xgbResult state like PathPlanning

  const navigate = useNavigate();
  const location = useLocation();

  // Use HQ from trip if available
  const trip = trips[selected];
  const HQ = trip && trip.hqLat && trip.hqLng ? { lat: Number(trip.hqLat), lng: Number(trip.hqLng) } : DEFAULT_HQ;

  // Shared button style
  const buttonStyle = {
    background: "#43a047",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 24px",
    fontWeight: 600,
    fontSize: "1.05em",
    cursor: toggleLoading ? "wait" : "pointer",
    marginLeft: 10,
    opacity: toggleLoading ? 0.7 : 1
  };

  // Reload trips whenever this page is navigated to
  useEffect(() => {
    const allTrips = JSON.parse(localStorage.getItem("allTrips") || "[]");
    setTrips(allTrips.slice().reverse());
    setSelected(0);
  }, [location]);

  // Load xgbResult from localStorage (same as PathPlanning.jsx)
  useEffect(() => {
    const result = localStorage.getItem("xgbResult");
    if (result && result !== "undefined") {
      try {
        const parsedResult = JSON.parse(result);
        setXgbResult(parsedResult);
      } catch (e) {
        console.error("Failed to parse xgbResult:", e);
        setXgbResult(null);
      }
    } else {
      setXgbResult(null);
    }
  }, []);

  // Calculate drone time if possible
  useEffect(() => {
    // Always use ML prediction if available
    const xgbResult = localStorage.getItem("xgbResult");
    if (xgbResult && xgbResult !== "undefined") {
      try {
        const parsedResult = JSON.parse(xgbResult);
        if (parsedResult && (parsedResult.predicted_time_minutes || parsedResult.time)) {
          setDroneTime(parsedResult.predicted_time_minutes || parsedResult.time);
          return;
        }
      } catch (e) {
        console.error("Failed to parse xgbResult:", e);
      }
    }
    setDroneTime(null);
  }, [trip]);

  // Call ORS for truck route
  useEffect(() => {
    async function getORSRoute(waypoints) {
      setTruckRoute({ distance: null, duration: null, loading: true, error: null });
      try {
        const parsedWaypoints = waypoints.map(wp => ({
          latitude: parseFloat(wp.latitude),
          longitude: parseFloat(wp.longitude)
        })).filter(wp => !isNaN(wp.latitude) && !isNaN(wp.longitude));
        const coordinates = parsedWaypoints.map(wp => [wp.longitude, wp.latitude]);
        if (coordinates.length < 2) {
          setTruckRoute({ distance: null, duration: null, loading: false, error: "Not enough waypoints for route" });
          setTruckTime(null);
          return;
        }
                const res = await axios.post(
          "/orsapi/v2/directions/driving-car/geojson",
          { coordinates },
          {
            headers: {
              "Authorization": import.meta.env.VITE_ORS_API_KEY,
              "Content-Type": "application/json"
            }
          }
        );

        const summary = res.data.features[0].properties.summary;
        setTruckRoute({
          distance: (summary.distance / 1000).toFixed(2), // km
          duration: (summary.duration / 60).toFixed(0),   // min, rounded
          loading: false,
          error: null
        });
        setTruckTime((summary.duration / 60).toFixed(0));
      } catch (err) {
        console.error("ORS error:", err, err?.response?.data);
        setTruckRoute({ distance: null, duration: null, loading: false, error: err.message || "Failed to fetch route" });
        setTruckTime(null);
      }
    }
    if (trip && trip.truckDeliveries && trip.truckDeliveries.length > 0) {
      const waypoints = [
        { latitude: HQ.lat, longitude: HQ.lng },
        ...trip.truckDeliveries.map(del => ({
          latitude: del.latitude,
          longitude: del.longitude
        }))
      ];
      getORSRoute(waypoints);
    }
  }, [trip]);

  const handleFinishDelivery = async () => {
    if (!trip?.drone) {
      alert("No drone assigned to this trip.");
      return;
    }
    setToggleLoading(true);
    try {
      await axios.put(`/api/v1/drones/toggleavailability/${trip.drone.droneId}`);

      let dronesList = JSON.parse(localStorage.getItem("dronesList") || "[]");
      dronesList = dronesList.map(d =>
        d.droneId === trip.drone.droneId
          ? { ...d, available: !d.available }
          : d
      );
      localStorage.setItem("dronesList", JSON.stringify(dronesList));

      trip.drone.available = !trip.drone.available;
      const allTrips = JSON.parse(localStorage.getItem("allTrips") || "[]").map(t =>
        t.drone && t.drone.droneId === trip.drone.droneId
          ? { ...t, drone: { ...t.drone, available: trip.drone.available } }
          : t
      );
      localStorage.setItem("allTrips", JSON.stringify(allTrips));
      setTrips(allTrips.slice().reverse());

      // Mark this delivery as finished
      const tripId = `${trip.createdAt}_${trip.drone?.droneId}`;
      setFinishedDeliveries(prev => new Set([...prev, tripId]));

      alert("Drone availability toggled successfully!");
    } catch (error) {
      alert("Failed to toggle drone availability: " + (error?.response?.data?.error || error.message));
    } finally {
      setToggleLoading(false);
    }
  };

  const handleClearAllTrips = () => {
    if (window.confirm("Are you sure you want to clear all trips? This action cannot be undone.")) {
      localStorage.removeItem("allTrips");
      localStorage.removeItem("latestTrip");
      localStorage.removeItem("xgbResult");
      setTrips([]);
      setSelected(0);
      setFinishedDeliveries(new Set());
      alert("All trips have been cleared successfully!");
    }
  };

  if (!trips.length) {
    return <p style={{ padding: "20px" }}>No trip data found. Please add drones and deliveries.</p>;
  }

  // Define trip data variables first
  let droneDelivery = trip?.droneDelivery;
  let truckDeliveries = trip?.truckDeliveries || [];

  // --- TRUE HYBRID LAUNCH/LAND LOGIC (copied from PathPlanning.jsx) ---
  // Find launch point using the same logic as PathPlanning
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
    return route;
  }
  let optimizedNodeOrder = nearestNeighborRoute(HQ, truckDeliveries);
  const { point: launchPoint, idx: launchIdx, frac: launchFrac } = closestPointOnPolyline(
    optimizedNodeOrder,
    droneDelivery?.latitude,
    droneDelivery?.longitude,
    50
  );
  const landingPoint = launchPoint;
  // Find launchInsertIdx as in PathPlanning
  const userTrip = [HQ, ...truckDeliveries, HQ];
  let launchInsertIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < userTrip.length - 1; i++) {
    const [lat1, lng1] = [userTrip[i].latitude || userTrip[i].lat, userTrip[i].longitude || userTrip[i].lng];
    const [lat2, lng2] = [userTrip[i+1].latitude || userTrip[i+1].lat, userTrip[i+1].longitude || userTrip[i+1].lng];
    if (!launchPoint || launchPoint[0] == null || launchPoint[1] == null) continue;
    const dist = haversineDistance(launchPoint[0], launchPoint[1], lat1, lng1) + haversineDistance(launchPoint[0], launchPoint[1], lat2, lng2);
    if (dist < minDist) {
      minDist = dist;
      launchInsertIdx = i + 1;
    }
  }

  // --- Carbon Emission Calculation (Copied from PathPlanning.jsx) ---
  const TRUCK_EMISSION_PER_KM = 0.746; // kg CO2/km
  const DRONE_EMISSION_PER_KM = 0.062; // kg CO2/km

  // Calculate the actual distances for both scenarios
  const droneDeliveryDistance = haversineDistance(launchPoint[0], launchPoint[1], droneDelivery.latitude, droneDelivery.longitude);

  // Scenario 1: Truck-only (all deliveries by truck)
  let truckOnlyTotalDistance = 0;
  let prevPoint = HQ;
  truckDeliveries.forEach(del => {
    const dist = haversineDistance(prevPoint.lat, prevPoint.lng, del.latitude, del.longitude);
    truckOnlyTotalDistance += dist;
    prevPoint = { lat: del.latitude, lng: del.longitude };
  });
  truckOnlyTotalDistance += haversineDistance(prevPoint.lat, prevPoint.lng, droneDelivery.latitude, droneDelivery.longitude);
  const truckOnlyCarbon = truckOnlyTotalDistance * TRUCK_EMISSION_PER_KM;

  // Scenario 2: Hybrid (truck delivers other packages, drone delivers this package)
  let hybridTruckDistance = 0;
  prevPoint = HQ;
  truckDeliveries.forEach(del => {
    const dist = haversineDistance(prevPoint.lat, prevPoint.lng, del.latitude, del.longitude);
    hybridTruckDistance += dist;
    prevPoint = { lat: del.latitude, lng: del.longitude };
  });
  hybridTruckDistance += haversineDistance(prevPoint.lat, prevPoint.lng, launchPoint[0], launchPoint[1]);
  if (launchInsertIdx < truckDeliveries.length) {
    hybridTruckDistance += haversineDistance(launchPoint[0], launchPoint[1], truckDeliveries[launchInsertIdx].latitude, truckDeliveries[launchInsertIdx].longitude);
  }
  const hybridTruckCarbon = hybridTruckDistance * TRUCK_EMISSION_PER_KM;
  const hybridDroneCarbon = droneDeliveryDistance * DRONE_EMISSION_PER_KM;
  const hybridCarbon = hybridTruckCarbon + hybridDroneCarbon;

  // Carbon reduction = (truck-only - hybrid) / truck-only * 100
  const carbonReduction = truckOnlyCarbon > 0 ? ((truckOnlyCarbon - hybridCarbon) / truckOnlyCarbon) * 100 : 0;
  // Carbon emission saved = truck-only - hybrid
  const carbonEmission = truckOnlyCarbon - hybridCarbon;

  // --- Estimated Time Calculation (Copied from PathPlanning.jsx) ---
  function getSegmentTime(ptA, ptB, typeA, typeB) {
    if (!ptA || !ptB || ptA[0] == null || ptA[1] == null || ptB[0] == null || ptB[1] == null) return NaN;
    const [latA, lngA] = ptA;
    const [latB, lngB] = ptB;
    const dist = haversineDistance(latA, lngA, latB, lngB);
    // Use ML time (predicted_time_minutes or time) for drone segments
    const mlMinutes = xgbResult && (xgbResult.predicted_time_minutes ?? xgbResult.time);
    if ((typeA === "Launch" && typeB === "DroneDelivery") || 
        (typeA === "DroneDelivery" && typeB === "Landing")) {
      if (mlMinutes) {
        return Number(mlMinutes);
      }
      return (dist / 40) * 60; // fallback to calculated time
    }
    if (typeA === "HQ" || typeB === "HQ" || 
        (typeA === "Truck" && typeB === "Truck") ||
        (typeA === "Truck" && typeB === "Launch") ||
        (typeA === "Launch" && typeB === "Truck")) {
      return (dist / 30) * 60; // truck speed
    }
    if (typeA === "Landing" && typeB === "Truck") {
      return (dist / 30) * 60;
    }
    return (dist / 30) * 60;
  }
  // Calculate total trip time as the sum of all segment times in the traversal order
  let traversalPoints = [];
  if (HQ.lat != null && HQ.lng != null) {
    traversalPoints.push({ label: String.fromCharCode(65), type: "HQ", coords: [HQ.lat, HQ.lng] });
  }
  for (let i = 0; i < launchInsertIdx; i++) {
    if (truckDeliveries[i] && truckDeliveries[i].latitude != null && truckDeliveries[i].longitude != null) {
      traversalPoints.push({ label: String.fromCharCode(65 + i + 1), type: "Truck", coords: [truckDeliveries[i].latitude, truckDeliveries[i].longitude] });
    }
  }
  if (launchPoint && launchPoint[0] != null && launchPoint[1] != null) {
    traversalPoints.push({ label: String.fromCharCode(65 + launchInsertIdx + 1), type: "Launch", coords: launchPoint });
  }
  if (droneDelivery && droneDelivery.latitude != null && droneDelivery.longitude != null) {
    traversalPoints.push({ label: String.fromCharCode(65 + launchInsertIdx + 2), type: "DroneDelivery", coords: [droneDelivery.latitude, droneDelivery.longitude] });
  }
  if (landingPoint && landingPoint[0] != null && landingPoint[1] != null) {
    traversalPoints.push({ label: String.fromCharCode(65 + launchInsertIdx + 3), type: "Landing", coords: landingPoint });
  }
  for (let i = launchInsertIdx; i < truckDeliveries.length; i++) {
    if (truckDeliveries[i] && truckDeliveries[i].latitude != null && truckDeliveries[i].longitude != null) {
      traversalPoints.push({ label: String.fromCharCode(65 + launchInsertIdx + 4 + (i - launchInsertIdx)), type: "Truck", coords: [truckDeliveries[i].latitude, truckDeliveries[i].longitude] });
    }
  }
  const totalTripTime = traversalPoints.slice(0, -1).reduce((sum, pt, idx) => {
    return sum + getSegmentTime(
      traversalPoints[idx].coords,
      traversalPoints[idx + 1].coords,
      traversalPoints[idx].type,
      traversalPoints[idx + 1].type
    );
  }, 0);

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

  console.log(`[TripResults] Total trip time: ${totalTripTime} min`);
  console.log(`[TripResults] Traversal points:`, traversalPoints.map(pt => ({ type: pt.type, coords: pt.coords })));
  console.log(`[TripResults] xgbResult:`, xgbResult);

  return (
    <div className="path-planning-page">
      <div className="left-panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2>All Trips</h2>
          {trips.length > 0 && (
            <button
              onClick={handleClearAllTrips}
              style={{
                background: "#d32f2f",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                padding: "8px 16px",
                fontWeight: 600,
                fontSize: "0.9em",
                cursor: "pointer",
                transition: "background 0.2s"
              }}
              onMouseOver={(e) => e.target.style.background = "#b71c1c"}
              onMouseOut={(e) => e.target.style.background = "#d32f2f"}
            >
              Clear All
            </button>
          )}
        </div>
        <div style={{ maxHeight: 400, overflowY: 'auto', marginBottom: 24 }}>
          {trips.map((t, i) => {
            const carbonReduction = Number(t.carbonReduction);
            const totalTripTime = Number(t.totalTripTime);
            // Prefer ML-suggested drone id if available
            const droneId = t.mlDroneId || (t.drone ? t.drone.droneId : 'N/A');
            return (
              <div
                key={`${t.createdAt || ''}_${i}`}
                className={`delivery-card${i === selected ? ' selected' : ''}`}
                style={{ cursor: 'pointer', marginBottom: 12, border: i === selected ? '2px solid #1976d2' : '1px solid #ddd' }}
                onClick={() => setSelected(i)}
              >
                <div><b>Trip #{trips.length - i}</b> &nbsp;|&nbsp; {new Date(t.createdAt).toLocaleString()}</div>
                <div style={{ fontSize: 13, color: '#555' }}>
                  Drone ID: {droneId} | Truck Delivery Locations: {t.truckDeliveries ? t.truckDeliveries.length : 0} | Carbon Reduction: {isFinite(carbonReduction) ? carbonReduction.toFixed(1) : 'N/A'}% | Time: {isFinite(totalTripTime) ? formatTimeMinutes(totalTripTime) : 'N/A'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="right-panel">
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
            color: (isFinite(Number(trip.carbonReduction)) && Number(trip.carbonReduction) >= 0) ? "#43a047" : "#d32f2f",
            marginBottom: 4
          }}>{isFinite(Number(trip.carbonReduction)) ? Number(trip.carbonReduction).toFixed(1) : 'N/A'}%</div>
          <div style={{ fontSize: "0.97em", color: "#666" }}>
            <span style={{marginRight: 16}}>
              <span style={{fontWeight: 500}}>Carbon Emission: </span>
              {isFinite(Number(trip.carbonEmission)) ? Number(trip.carbonEmission).toFixed(2) : 'N/A'} kg CO₂
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
            Estimated Time
            <span style={{ fontSize: 14, marginLeft: 8, color: "#d32f2f" }}>ML Enhanced</span>
          </div>
          <div style={{
            fontSize: "2em",
            fontWeight: 700,
            color: "#d32f2f"
          }}>{isFinite(Number(trip.totalTripTime)) ? formatTimeMinutes(Number(trip.totalTripTime)) : 'N/A'}</div>
          <div style={{ fontSize: "1em", color: "#1976d2", marginTop: 6 }}>
            <b>Time Saved:</b> {timeSaved > 0 ? formatTimeMinutes(timeSaved) : '0 sec'}
          </div>
        </div>
        
        
        <div className="button-group">
          {(() => {
            const tripId = `${trip.createdAt}_${trip.drone?.droneId}`;
            const isFinished = finishedDeliveries.has(tripId);
            
            if (isFinished) {
              return (
                <div style={{
                  background: "#e8f5e8",
                  color: "#2e7d32",
                  border: "2px solid #4caf50",
                  borderRadius: 8,
                  padding: "12px 24px",
                  fontWeight: 600,
                  fontSize: "1.05em",
                  textAlign: "center"
                }}>
                  ✅ Delivery Finished
                </div>
              );
            }
            
            return (
              <button
                className="finish-btn"
                style={buttonStyle}
                onClick={handleFinishDelivery}
                disabled={toggleLoading}
              >
                {toggleLoading ? "Finishing..." : "Finish Delivery"}
              </button>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

