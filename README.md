# OSCP Point of Interest service
Thise web service can collect points of interest from a number of third-party POI services. Currently Google Maps and OpenStreetMap are used. The API takes in search query words, the queries are performed by the third-party services, and their results are aggregated (duplicates are filtered) and returned in OGC POI standard format.

## API

### `GET /locations`

Search for points of interest within 200 meters of the supplied coordinates. Results are collected from OpenStreetMap and, when `GOOGLE_MAPS_API_KEY` is configured on the service, Google Places.

When running with Docker Compose and `PORT=8043`, the local endpoint is `http://localhost:8043/locations`. Compose publishes this host port to port 3000 inside the container.

Required query parameters:

| Parameter | Requirements | Description |
| --- | --- | --- |
| `lat` | Number from -90 to 90 | Latitude of the search center. |
| `lng` | Number from -180 to 180 | Longitude of the search center. |
| `textQuery` | Non-empty string, at most 200 characters; provide once | Place name, type, or amenity to search for. |

Example request:

```sh
curl --get "http://localhost:8043/locations" \
	--data-urlencode "lat=40.7128" \
	--data-urlencode "lng=-74.0060" \
	--data-urlencode "textQuery=coffee shop"
```

On success, the service returns a `FeatureCollection` with matching POIs in `features`. Each result includes its name, location, category, and available address details. `geometry.coordinates` are returned in `[latitude, longitude]` order. If one data source fails while another succeeds, the response can still be successful and include a `warnings` array describing the unavailable source.

Errors are JSON objects with an `error` message and may include `details`:

| Status | Meaning |
| --- | --- |
| `400` | A required query parameter is missing, invalid, repeated, or too long. |
| `404` | The requested route does not exist. |
| `502` | All attempted POI sources failed. |
| `503` | No POI sources are currently available, such as while OpenStreetMap is rate-limited and Google Places is not configured. |

## Running via Docker
Create `.env` file with the following contents:
```
GOOGLE_MAPS_API_KEY=
PORT=8043
MY_HTTP_PROXY=
MY_HTTPS_PROXY=
```

Build the container:
```
docker compose -f docker-compose.yml --env-file .env build
```

Run the container:
```
docker compose -f docker-compose.yml --env-file .env up -d
```
