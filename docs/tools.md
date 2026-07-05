# Tool Catalog - AVEVA PI System MCP Server

This document catalogues all tools exposed by the MCP server, their inputs, annotations, and mapping to the upstream PI Web API.

---

## 1. Discovery Tools (`pi.discovery.*`)

Discovery tools are read-only and idempotent. They are used to browse the hierarchy of data servers, asset servers, databases, elements, and attributes.

| Tool Name | Description | Upstream Endpoint Mapped |
|---|---|---|
| `pi.discovery.list_data_servers` | List all registered PI Data Servers (Archives). | `GET /piwebapi/dataservers` |
| `pi.discovery.list_asset_servers` | List all registered PI Asset Servers (AF Servers). | `GET /piwebapi/assetservers` |
| `pi.discovery.list_asset_databases` | List AF databases on a specific AF Server. | `GET /piwebapi/assetservers/{webId}/assetdatabases` |
| `pi.discovery.search_points` | Search for PI points (tags) on a Data Server. | `GET /piwebapi/dataservers/{webId}/points` |
| `pi.discovery.search_elements` | Search for AF elements in a Database. | `GET /piwebapi/assetdatabases/{webId}/elements` |
| `pi.discovery.list_child_elements` | List children of a specific AF element. | `GET /piwebapi/elements/{webId}/elements` |
| `pi.discovery.search_attributes` | Search attributes per-element or database-wide. | `GET /piwebapi/elements/{webId}/attributes` (element) or `GET /piwebapi/assetdatabases/{webId}/elementattributes` (database) |
| `pi.discovery.search_event_frames` | Search for AF Event Frames in a Database. | `GET /piwebapi/assetdatabases/{webId}/eventframes` |
| `pi.discovery.list_templates` | List element templates in an AF database. | `GET /piwebapi/assetdatabases/{webId}/elementtemplates` |
| `pi.discovery.list_categories` | List AF element categories. | `GET /piwebapi/assetdatabases/{webId}/elementcategories` |
| `pi.discovery.resolve_point` | Resolve details for a single PI point. | `GET /piwebapi/points/{webId}` |

---

## 2. Data Retrieval Tools (`pi.data.*`)

Data tools are read-only and idempotent. They support projections (`selectedFields`) to minimize network sizes, and results are filtered by the size guard to protect client context budgets.

| Tool Name | Description | Upstream Endpoint Mapped |
|---|---|---|
| `pi.data.get_value` | Get current value of a point or attribute. | `GET /piwebapi/streams/{webId}/value` |
| `pi.data.get_value_multi` | Get current value of multiple points or attributes. | `GET /piwebapi/streamsets/value` |
| `pi.data.get_end` | Get last recorded value of a stream. | `GET /piwebapi/streams/{webId}/end` |
| `pi.data.read_recorded` | Read recorded values over a time range. | `GET /piwebapi/streams/{webId}/recorded` |
| `pi.data.read_recorded_multi` | Read recorded values for multiple streams. | `GET /piwebapi/streamsets/recorded` |
| `pi.data.read_interpolated` | Read interpolated values on a time grid. | `GET /piwebapi/streams/{webId}/interpolated` |
| `pi.data.read_interpolated_multi` | Read interpolated values for multiple streams. | `GET /piwebapi/streamsets/interpolated` |
| `pi.data.read_interpolated_attimes` | Read interpolated values at specific times. | `GET /piwebapi/streams/{webId}/interpolatedattimes` |
| `pi.data.read_plot` | Read decimated values for visualization. | `GET /piwebapi/streams/{webId}/plot` |
| `pi.data.read_summary` | Read summaries (Avg, Min, Max, Total) over a range. | `GET /piwebapi/streams/{webId}/summary` |
| `pi.data.read_summary_multi` | Read summaries for multiple streams. | `GET /piwebapi/streamsets/summary` |

---

## 3. Ingestion/Write Tools (`pi.write.*`)

Write tools are destructive and non-idempotent. They are only advertised and accessible when writes are enabled (`MCP_WRITE_TOOLS_ENABLED=true`).

| Tool Name | Description | Upstream Endpoint Mapped |
|---|---|---|
| `pi.write.value` | Write a single value to a point or attribute. | `POST /piwebapi/streams/{webId}/value` |
| `pi.write.values` | Write a series of values to a single stream. | `POST /piwebapi/streams/{webId}/recorded` |
| `pi.write.values_multi` | Write values to multiple streams in a batch. | `POST /piwebapi/streamsets/recorded` |

---

## 4. Meta/Server Tools (`pi.meta.*`)

Server tools are metadata operations.

| Tool Name | Description | Upstream Endpoint Mapped |
|---|---|---|
| `pi.meta.server_status` | Retrieve status of the MCP server and connections. | `/piwebapi/system/status` (where permitted) |
