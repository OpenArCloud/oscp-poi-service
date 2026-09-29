require('dotenv').config();
const express = require("express");
const cors = require("cors");
require('https').globalAgent.options.ca = require('ssl-root-cas').create();

// Network proxy
const { setGlobalDispatcher, ProxyAgent } = require("undici");
const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (httpsProxy) {
  // Corporate proxy uses CA not in undici's certificate store
  //process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const dispatcher = new ProxyAgent({uri: new URL(httpsProxy).toString() });
  setGlobalDispatcher(dispatcher);
}


const PORT = process.env.PORT || 3000;
const apiKey = process.env.GOOGLE_MAPS_API_KEY;
const searchRadius = 200;
const UPSTREAM_TIMEOUT_MS = 10000;
const MAX_QUERY_LENGTH = 200;

let OSMenable = true;

const app = express();
app.use(express.json());
app.use(cors());


var stringSimilarity = require("string-similarity");

const amenities = ["bar", "bbq", "biergarten", "cafe", "fast_food", "food_court", "ice_cream", "pub", "restaurant", "college", "driving_school", 
  "kindergarten", "language_school", "library", "music_school", "school", "university", "bicycle_parking", "bicycle_repair_station", 
  "bicycle_rental", "boat_rental", "boat_sharing", "bus_station", "car_rental", "car_sharing", "car_wash", "charging_station", "ferry_terminal", 
  "fuel", "parking", "taxi", "motorcycle_parking", "bank", "atm", "bureau_de_change", "baby_hatch", "clinic", "dentist", "doctors", "hospital", 
  "nursing_home", "pharmacy", "veterinary", "arts_centre", "casino", "cinema", "community_centre", "conference_centre", "events_venue", "nightclub", 
  "planetarium", "social_centre", "stripclub", "studio", "theatre", "animal_boarding", "animal_shelter", "bench", "clock", "drinking_water", "fountain",
   "hunting_stand", "marketplace", "place_of_worship", "playground", "public_bath", "shelter", "shower", "toilets", "townhall", "courthouse", 
   "embassy", "fire_station", "police", "post_box", "post_office", "prison", "ranger_station", "recycling", "waste_basket", "waste_disposal", 
   "water_point", "watering_place", "crematorium", "funeral_hall", "grave_yard", "gym", "sports_centre", "stadium", "swimming_pool", "golf_course", 
   "fitness_centre"]

//checks if the query is similar to an amenity
function checkAmenity(keyword){
  let newKeywords = [];
  keyword = keyword.toLowerCase();
  keyword = keyword.replaceAll(" ", "_");
  amenities.forEach((amenity) => {
      if(amenity.includes(keyword)){
          newKeywords[newKeywords.length] = amenity;
      }
      else if(keyword.includes(amenity)){
        newKeywords[newKeywords.length] = amenity;
      }
  });

  return newKeywords;
}

function getLngLength(latitude) {
  let a = 6378137.0;
  let latradians = latitude * Math.PI / 180;
  let lnglength = Math.PI / 180 * a * Math.cos(latradians);
  return lnglength;
}

function getLatLength(latitude) {
  let latradians = latitude * Math.PI / 180;
  let latlength = 111132.954 - 559.822 * Math.cos(2 * latradians) + 1.175 * Math.cos(4 * latradians);
  return latlength;
}

//Checks is a found place is within a certain radius of your location. It takes into account your position on the globe
//This is needed because the built in radius function does not work properly. We filter out the unwanted results
function withinRadius(positionLat, positionLng, placeLat, placeLng, radius) {
  let latLength = getLatLength(positionLat);
  let lngLength = getLngLength(positionLat);

  let latDistance = (positionLat - placeLat) * latLength;
  let lngDistance = (positionLng - placeLng) * lngLength;

  let distanceFromPlace = Math.sqrt(Math.pow(latDistance, 2) + Math.pow(lngDistance, 2));
  if (distanceFromPlace <= radius) {
    return true;
  }
  else {
    return false;
  }
}

function getAddressDetails(addressComponents) {
  const component = (...types) => {
    for (const type of types) {
      const match = (addressComponents || []).find(c => c.types?.includes(type));
      if (match) {
        return match.longText;
      }
    }
    return undefined;
  };
  const street = [component("route"), component("street_number")].filter(Boolean).join(" ");
  return {
    city: component("locality", "postal_town", "administrative_area_level_3"),
    address: street || undefined,
    postalCode: component("postal_code"),
    country: component("country")
  };
}

function createPOI(placeLat, placeLng, placeName, address, city, country, postalCode, placeCategory) {


  //if we do not get the category of the place the default category will be set as landmark
  if(placeCategory == undefined){
    placeCategory = "landmark";
  }

  const poi = {
      type: "Feature",
      content: {
        type: "POI"
      },
      geometry:{
      coordinates: [
        placeLat,
        placeLng
      ]
    },
    featureID: Math.floor(Math.random()*100000000),
    name:{
      name: placeName
    },

    haspayload: {
      usesSchema: [
        {
          href: "https://genpoijson.org/schema/interchangepoi.json",
          rel: "describedby"
        }
      ],
      address:{
        deliveryPoint: address,
        city: city,
        postalCode: postalCode,
        country: country
      }
    },

    category: {
      category: placeCategory,
      categoryFormat: "ogcindoor"
    }
  }

  return poi;
}

//checks if either one of the strings is substring of the other
function isSubstring(string1, string2){
  if(string2.includes(string1)){
    return true;
  }
  else if(string1.includes(string2)){
    return true;
  }
  return false;
}

//checks if the array already consists a poi with the given name
function containsWithName(poiArray, name, lat, lng){
  if(poiArray.length === 0){
    return false;
  }
  for(let i = 0; i < poiArray.length; i++){
    if(isSubstring(poiArray[i].name.name,name) || 
    (stringSimilarity.compareTwoStrings(poiArray[i].name.name,name) >= 0.6 && 
    withinRadius(lat,lng,poiArray[i].geometry.coordinates[0],poiArray[i].geometry.coordinates[1],7))){
      return true;
    }
  }
  return false;
}

//checks if there is a poi with more information with the same name, if there is, it return that poi
function moreDataWithThisName(poiArray, datacount, name, lat, lng){
  let betterPoi = undefined;
  let maxDatacount = datacount;

  for(let i = 0; i < poiArray.length; i++){
    if(isSubstring(poiArray[i].name.name,name) || 
    (stringSimilarity.compareTwoStrings(poiArray[i].name.name,name) >= 0.6 && 
    withinRadius(lat,lng,poiArray[i].geometry.coordinates[0],poiArray[i].geometry.coordinates[1],7))){
      let newPoiDatacount = 0;
      if(poiArray[i].haspayload.address.deliveryPoint != undefined){
        newPoiDatacount++;
      }
      if(poiArray[i].haspayload.address.postalCode != undefined){
        newPoiDatacount++;
      }
      if(poiArray[i].haspayload.address.city != undefined){
        newPoiDatacount++;
      }
      if(poiArray[i].haspayload.address.country != undefined){
        newPoiDatacount++;
      }
      if(newPoiDatacount > maxDatacount){
        maxDatacount = newPoiDatacount;
        betterPoi = poiArray[i];
      }
    }
  }
  return betterPoi;
}

//we remove the duplicate finds using the names of the pois
function removeDuplicatesbyName(poiArray){
  if(poiArray.length === 0){
    return poiArray;
  }
    let newPoiArray = [];

    poiArray.forEach(poi => {
      if(poi.name.name != undefined){
        if(!containsWithName(newPoiArray, poi.name.name, poi.geometry.coordinates[0], poi.geometry.coordinates[1])){
          newPoiArray.push(poi);
        }
      }
    });

    for(let i = 0; i < newPoiArray.length; i++){
      if(newPoiArray[i].name.name != undefined){
        let datacount = 0;
        if(newPoiArray[i].haspayload.address.deliveryPoint != undefined){
          datacount++;
        }
        if(newPoiArray[i].haspayload.address.postalCode != undefined){
          datacount++;
        }
        if(newPoiArray[i].haspayload.address.city != undefined){
          datacount++;
        }
        if(newPoiArray[i].haspayload.address.country != undefined){
          datacount++;
        }
        let newPoi = moreDataWithThisName(poiArray, datacount, newPoiArray[i].name.name, newPoiArray[i].geometry.coordinates[0],newPoiArray[i].geometry.coordinates[1]);
        if(newPoi != undefined){
          newPoiArray[i] = newPoi;
        }
      }
      }
    return newPoiArray;
}

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function fetchJson(source, url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (error) {
    if (error.name === "TimeoutError") {
      throw new ApiError(504, `${source} did not respond within ${UPSTREAM_TIMEOUT_MS / 1000} seconds`);
    }
    throw new ApiError(502, `Could not reach ${source}: ${error.cause?.message || error.message}`);
  }
  if (!response.ok) {
    // Google APIs return {error: {message}} bodies that explain the failure
    const upstreamMessage = await response.json().then(body => body?.error?.message, () => undefined);
    throw new ApiError(502, `${source} returned HTTP ${response.status} ${response.statusText}${upstreamMessage ? `: ${upstreamMessage}` : ""}`);
  }
  try {
    return await response.json();
  } catch {
    throw new ApiError(502, `${source} returned an invalid JSON response`);
  }
}

// Places API (New) Text Search: https://developers.google.com/maps/documentation/places/web-service/text-search
async function fetchGooglePlaces(source, textQuery, lat, lng) {
  const data = await fetchJson(source, "https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.displayName,places.location,places.addressComponents,places.primaryType,places.types"
    },
    body: JSON.stringify({
      textQuery,
      pageSize: 20,
      rankPreference: "DISTANCE",
      locationBias: {
        circle: { center: { latitude: lat, longitude: lng }, radius: searchRadius }
      }
    })
  });
  return data.places || [];
}

function googlePlacesToPOIs(places, myLat, myLng) {
  const pois = [];
  places.forEach(place => {
    const location = place.location;
    const name = place.displayName?.text;
    if (!location || !name) {
      return;
    }
    if (withinRadius(myLat, myLng, location.latitude, location.longitude, searchRadius)) {
      const addressDetails = getAddressDetails(place.addressComponents);
      pois.push(createPOI(location.latitude, location.longitude, name, addressDetails.address, addressDetails.city, addressDetails.country, addressDetails.postalCode, place.primaryType || place.types?.[0]));
    }
  });
  return pois;
}

// Rejects arrays/objects (e.g. ?lat=1&lat=2) and partial numbers like "12abc" that parseFloat would accept
function parseCoordinate(value, name, limit) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(number) || Math.abs(number) > limit) {
    throw new ApiError(400, `Query parameter '${name}' is required and must be a single number between -${limit} and ${limit}`);
  }
  return number;
}

function parseTextQuery(value) {
  if (Array.isArray(value)) {
    throw new ApiError(400, "Query parameter 'textQuery' must be given only once");
  }
  // eslint-disable-next-line no-control-regex
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  if (!text) {
    throw new ApiError(400, "Query parameter 'textQuery' is required and must not be empty");
  }
  if (text.length > MAX_QUERY_LENGTH) {
    throw new ApiError(400, `Query parameter 'textQuery' must be at most ${MAX_QUERY_LENGTH} characters`);
  }
  return text;
}

app.get("/locations", async (req, res, next) => {
  try {
    const myLat = parseCoordinate(req.query.lat, "lat", 90);
    const myLng = parseCoordinate(req.query.lng, "lng", 180);
    const textQuery = parseTextQuery(req.query.textQuery);

    const pois = [];
    const warnings = [];
    let attempted = 0;
    let failed = 0;

    // A failing source is reported as a warning so the remaining sources can still return results
    const collect = async (source, fetchPOIs) => {
      attempted++;
      try {
        pois.push(...await fetchPOIs());
      } catch (error) {
        failed++;
        console.error(`${source} error:`, error);
        warnings.push(error instanceof ApiError ? error.message : `${source} failed: ${error.message}`);
      }
    };

    if (apiKey) {
      // Nearby Search (New) has no free-text keyword, so a single distance-ranked Text Search replaces both legacy calls
      await collect("Google Places text search", async () => {
        return googlePlacesToPOIs(await fetchGooglePlaces("Google Places text search", textQuery, myLat, myLng), myLat, myLng);
      });
    } else {
      warnings.push("Google Places skipped: GOOGLE_MAPS_API_KEY is not configured on the server");
    }

    const apiURLOpenStreetMap = "https://overpass-api.de/api/interpreter";
    let word = checkAmenity(textQuery);
    let amenities = "";
    let query = ''
    if (word.length == 0){
      // Escape regex metacharacters, then quotes/backslashes for the Overpass string literal
      const safeName = textQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/["\\]/g, "\\$&");
      query = `
      [out:json];
      node
      ["amenity"]
      ["name"~"${safeName}", i]
      (around:${searchRadius}, ${myLat}, ${myLng});
      out;
      `;
    }
    else{
      if(word.length > 1){
        for(let i = 0; i < word.length; i++){
          amenities = amenities + word[i];
          if(i < word.length - 1){
            amenities = amenities + '|';
          }
        }
        word = amenities;
        word = '~"' + word;
      }
      else{
        word = '="' + word;
      }
      query = `
      [out:json];
      node
      ["amenity"${word}"]
      (around:${searchRadius}, ${myLat}, ${myLng});
      out;
      `;
    }
    if(OSMenable){
      OSMenable = false;
      await collect("OpenStreetMap Overpass", async () => {
        try {
          // Overpass rejects anonymous clients with 406; it requires an identifying User-Agent
          const data = await fetchJson("OpenStreetMap Overpass", apiURLOpenStreetMap, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Accept": "application/json",
              "User-Agent": "oscp-poi-service/1.0"
            },
            body: new URLSearchParams({ data: query }).toString()
          });
          const osmPois = [];
          (data.elements || []).forEach(place => {
            const tags = place.tags || {};
            let street = tags["addr:street"];
            let houseNumber = tags["addr:housenumber"];
            let deliveryPoint = (street === undefined || houseNumber === undefined) ? undefined : street + ' ' + houseNumber;
            if(tags.name != undefined){
              osmPois.push(createPOI(place.lat, place.lon, tags.name, deliveryPoint, tags["addr:city"], tags["addr:country"], tags["addr:postcode"], tags.amenity));
            }
          });
          return osmPois;
        } finally {
          setTimeout(() => { OSMenable = true; }, 1200);
        }
      });
    } else {
      warnings.push("OpenStreetMap skipped: rate limited, please retry in a moment");
    }

    if (attempted === 0) {
      throw new ApiError(503, "No POI sources are currently available", warnings);
    }
    if (failed === attempted) {
      throw new ApiError(502, "All POI sources failed", warnings);
    }

    const POICollection = {
      type: "FeatureCollection",
      features: removeDuplicatesbyName(pois)
    };
    if (warnings.length > 0) {
      POICollection.warnings = warnings;
    }
    res.json(POICollection);
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Request body is not valid JSON" });
  }
  const rawStatus = err.status || err.statusCode;
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
  if (status >= 500) {
    console.error(`Error handling ${req.method} ${req.originalUrl}:`, err);
  }
  const body = { error: (err instanceof ApiError || err.expose) ? err.message : "Internal server error" };
  if (err.details) {
    body.details = err.details;
  }
  res.status(status).json(body);
});

// Last resort: keep serving other requests instead of taking the whole service down
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

app.listen(PORT, () => {
  console.log(`OSCP POI Service is running at http://localhost:${PORT}`);
  if (!apiKey) {
    console.warn("GOOGLE_MAPS_API_KEY is not set; only OpenStreetMap will be queried");
  }
});
