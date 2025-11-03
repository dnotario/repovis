# RepoVis Technical Documentation

This document provides a technical overview of the RepoVis architecture for developers and AI agents who need to understand or modify the codebase.

## Architecture Overview

RepoVis is a three-component system:

1. **Preprocessor** (`preprocessor/preprocess.py`, 271 lines): Analyzes Git repositories and generates SQLite database
2. **Backend Server** (`server/server.py`, 368 lines): FastAPI server that serves the database via REST API
3. **Frontend** (`web/`, ~1343 lines JS + HTML/CSS): D3.js-based interactive visualization

```
┌─────────────────┐
│  Git Repository │
└────────┬────────┘
         │
         │ (1) Preprocessing
         ↓
┌─────────────────┐
│ SQLite Database │
└────────┬────────┘
         │
         │ (2) REST API
         ↓
┌─────────────────┐
│   Web Browser   │
│  (D3.js viz)    │
└─────────────────┘
```

## Component 1: Preprocessor

### Purpose
Extracts commit history, file changes, and contributor data from a Git repository into a structured SQLite database for efficient querying.

### Key Features
- **Hierarchical File Structure**: Automatically creates parent directories even if they weren't directly committed
- **Batched Processing**: Commits data in batches for performance (configurable batch size)
- **Progress Tracking**: Uses tqdm for visual progress feedback
- **Caching**: In-memory caches for file and contributor lookups to avoid redundant DB queries

### Database Schema

#### Tables

**metadata**
- Stores repository-level information
- Fields: `key`, `value`
- Example keys: `repo_name`, `total_commits`, `min_date`, `max_date`

**files**
- Hierarchical file/directory structure
- Fields: `id`, `path`, `parent_id`, `name`, `is_directory`
- Self-referential parent-child relationships
- Directories have paths ending with `/`

**contributors**
- Unique contributors identified by email
- Fields: `id`, `name`, `email`
- Indexed on email for fast lookups

**commits**
- Individual commit records
- Fields: `id`, `sha`, `date`, `message`, `contributor_id`
- Foreign key to contributors table

**file_metrics**
- Daily aggregated metrics per file per contributor
- Fields: `id`, `file_id`, `date`, `contributor_id`, `commit_count`, `lines_added`, `lines_deleted`
- Composite index on `(file_id, date, contributor_id)` for fast time-range queries
- This is the primary data source for the heatmap visualization

**timeline**
- Daily commit counts for the timeline chart
- Fields: `date`, `count`
- Pre-aggregated for performance

### Processing Algorithm

1. Initialize database and create schema
2. Open Git repository using GitPython
3. Store metadata (repository name, date range)
4. Iterate through all commits in chronological order:
   - Extract commit info (SHA, date, author, message)
   - Get or create contributor record
   - Store commit record
   - For each file in the commit diff:
     - Get or create file record (including parent directories)
     - Aggregate metrics: commit count, lines added/deleted
     - Store in daily buckets (file + date + contributor)
5. Generate timeline aggregates (total commits per day)
6. Create indexes for query performance
7. Commit to database

## Component 2: Backend Server

### Technology
- **FastAPI**: Modern Python web framework with automatic OpenAPI docs
- **Uvicorn**: ASGI server for high performance
- **SQLite**: Embedded database with row factory for dict results
- **CORS**: Enabled for development (allow all origins)

### API Endpoints

#### `GET /`
- Serves the main web interface (`index.html`)

#### `GET /api/metadata`
- Returns repository metadata
- Response: `{ "repo_name": "...", "total_commits": 12345, ... }`

#### `GET /api/tree`
- Returns file hierarchy with optional metrics
- Query parameters:
  - `start_date` (YYYY-MM-DD): Filter metrics from this date
  - `end_date` (YYYY-MM-DD): Filter metrics to this date
  - `contributors`: Comma-separated contributor IDs to include
  - `exclude_contributors`: Comma-separated contributor IDs to exclude (for "all minus a few" optimization)
  - `metric`: Type of metric to return (`commit_count`, `lines_added`, `lines_deleted`)
- Response: `{ "files": [...], "date_range": {...} }`
- SQL optimization: Uses IN or NOT IN based on selection size (fewer IDs = more efficient)

#### `GET /api/contributors`
- Returns list of all contributors
- Response: `{ "contributors": [{"id": 1, "name": "...", "email": "..."}] }`

#### `GET /api/timeline`
- Returns daily commit counts for timeline visualization
- Response: `{ "timeline": [{"date": "2024-01-01", "count": 42}] }`

### Performance Optimizations

1. **Smart Filtering**: 
   - If < 50% contributors selected: `WHERE contributor_id IN (...)`
   - If > 50% contributors selected: `WHERE contributor_id NOT IN (...)` (smaller list)
   - If all selected: No filter (most efficient)

2. **SQL Indexes**: Pre-built indexes on frequently queried columns

3. **Connection Pooling**: Single global DB connection (SQLite is single-threaded)

4. **Row Factory**: Returns rows as dictionaries for easy JSON serialization

## Component 3: Frontend

### Technology Stack
- **D3.js v7**: Data visualization library
- **Vanilla JavaScript**: No framework dependencies, ~1343 lines
- **HTML5/CSS3**: Modern layout with flexbox

### Architecture

The frontend is a single-page application with one main class: `TreemapVis`

### Key Classes and Data Structures

#### TreemapVis
Main visualization controller that manages:
- Data loading and caching
- Treemap rendering with D3.js
- Timeline brush interaction
- File tree explorer
- Contributors panel
- Zoom/pan state

#### Data Flow

```
Initial Load:
  1. getDateRangeFromTimeline() → cache timeline data
  2. loadFileStructure() → get full file hierarchy
  3. loadContributors() → get contributor list
  4. loadMetrics() → get initial metrics
  5. setupTimeline() → render timeline with brush
  6. setupTreemap() → create SVG and zoom behavior
  7. setupTreeExplorer() → load and render file tree
  8. setupContributorsPanel() → render contributor checkboxes
  9. computePercentiles() → calculate color scale
  10. render() → draw initial treemap

User Interaction:
  Timeline drag → loadMetrics() → computePercentiles() → updateColors()
  Contributor toggle → loadMetrics() → computePercentiles() → updateColors()
  Click file tree → highlightNodeInTreemap()
  Double-click directory → zoomToNode()
  Treemap click → clicked() (navigation, currently disabled)
```

### Color Algorithm

**Percentile-Based Heatmap**:
1. Collect all file metrics with value > 0
2. Sort commit values ascending
3. Build percentile map: `value → percentile (0.0-1.0)`
4. For each file:
   - If 0 commits: Yellow (#ffd700)
   - Otherwise: Map percentile to color scale
     - D3 `interpolateRdYlGn` scale (Red-Yellow-Green)
     - Domain reversed: `[1, 0]` so red = high percentile
     - 90th percentile → Red
     - 50th percentile → Yellow
     - 10th percentile → Green

**Directory Colors**: Aggregate of child values, 30% opacity

### Treemap Layout

**D3 Treemap Algorithm**:
- Layout in unit square `[0, 1] × [0, 1]` for better zoom behavior
- Hierarchy sized by **file count** (not commit count)
  - Each file contributes 1 to its parent's size
  - Ensures geometry is stable regardless of filters
- Squarified algorithm for balanced rectangles
- No padding between tiles for maximum space usage

**Zoom/Pan**:
- D3.zoom behavior with scale extent [0.1, 1000]
- Transform applied via scales (not direct transform)
- Prevents pixel rounding issues
- Viewport culling: only render tiles > 1px

### File Tree Explorer

**Separate Data Source**: Loads full tree structure independently for fast navigation

**Features**:
- Expandable tree with chevron icons
- Search filter (client-side)
- Hover → highlight in treemap
- Click → navigate and update breadcrumb
- Double-click directory → zoom treemap to directory bounds

**State Management**:
- `this.expandedNodes`: Set of expanded directory paths
- `this.currentFilter`: Current search text
- Preserves expansion state during re-renders

### Contributors Panel

**UI Components**:
- Search input (filters list client-side)
- Checkbox list (monospace font, right-aligned header)
- Select All / Clear All buttons (at bottom)

**Filtering Logic**:
- All contributors selected by default (Set data structure)
- Changes trigger immediate API call (no debouncing)
- Smart IN/NOT IN optimization happens server-side

**Request Queue**:
- Max 1 outstanding request to API
- If request in progress, newest request is queued
- When request completes, processes queued request
- Prevents race conditions and reduces server load

### Timeline

**D3 Timeline Chart**:
- Area chart showing commit activity over time
- X-axis: Time scale (dates)
- Y-axis: Linear scale (commit count)
- Brush for selecting time range

**Brush Behavior**:
- Drag handles or area to select date range
- `brush` events: Update during drag
- `end` events: Finalize selection
- Selected dates displayed as labels above timeline
- Request queue handles rapid brush movements

### Performance Optimizations

1. **Viewport Culling**: Only render tiles visible in viewport (width/height > 1px)

2. **Request Queue**: Maximum 1 concurrent API request
   - Prevents flooding server during timeline drag
   - Always processes most recent request (not FIFO)

3. **Percentile Caching**: Computed once per filter change, looked up O(1) during render

4. **Separate Tree Data**: File tree loads once, never reloads

5. **Transform-based Zoom**: Uses D3 scales instead of direct SVG transforms for precision

6. **Highlight Layer**: Separate SVG group for highlights, cleared on each render

## Development Workflow

### Making Changes

1. **Backend Changes**:
   ```bash
   cd server
   # Edit server.py
   # Restart server to see changes
   python3 server.py --db ../data/repo.db
   ```

2. **Frontend Changes**:
   ```bash
   cd web
   # Edit js/treemap.js, css/style.css, or index.html
   # Refresh browser to see changes (no build step)
   ```

3. **Schema Changes**:
   ```bash
   cd preprocessor
   # Edit schema.sql
   # Re-run preprocessor to regenerate database
   python3 preprocess.py /path/to/repo --output ../data/repo.db
   ```

### Testing

**Manual Testing**:
1. Generate database from small test repository
2. Start server
3. Open browser, interact with UI
4. Check browser console for errors
5. Inspect network tab for API calls

**No Automated Tests**: Currently no unit or integration tests

### Common Extension Points

**Adding a New Metric**:
1. Update `file_metrics` table in schema.sql
2. Modify preprocessor to calculate new metric
3. Add query parameter to `/api/tree` endpoint
4. Update frontend color scale or add new visualization

**Adding a New Filter**:
1. Add UI component in HTML/CSS
2. Add filter state to `TreemapVis` class
3. Pass filter to `loadMetrics()` calls
4. Update backend query to filter on new dimension

**Changing Color Scheme**:
- Modify `getColor()` function in `render()` method
- Replace `d3.interpolateRdYlGn` with different interpolator
- Adjust domain/thresholds for different percentile mapping

## Known Limitations

1. **Single-threaded SQLite**: One query at a time on backend
2. **Client-side Tree Filtering**: Search in file tree doesn't scale to 100k+ files
3. **No Undo/Redo**: State changes are immediate and not reversible
4. **No Bookmarking**: Cannot save/share specific views via URL
5. **No Export**: Cannot export visualization as image or data
6. **Large Repos**: Browsers may struggle with 50k+ files in treemap
7. **No Diff View**: Cannot see actual code changes from visualization

## Future Enhancements

**Potential Improvements**:
- Add unit tests for preprocessor and backend
- Implement URL state management for shareable views
- Add export to PNG/SVG functionality
- Progressive loading for very large repositories
- Code diff view when clicking files
- Commit message search
- Blame view integration
- Dark/light theme toggle
- Responsive design for mobile
- WebSocket for live updates (watch mode)

## Dependencies

### Python (server)
- `fastapi`: Web framework
- `uvicorn`: ASGI server
- `GitPython`: Git repository access (preprocessor)
- `tqdm`: Progress bars (preprocessor)

### JavaScript (frontend)
- `d3.js v7`: Loaded from CDN, no npm/build step

### Database
- SQLite 3: Embedded database, no separate server needed

## File Structure

```
repovis/
├── preprocessor/
│   ├── preprocess.py      # Main preprocessing script
│   ├── schema.sql         # Database schema
│   └── requirements.txt   # Python dependencies
├── server/
│   ├── server.py          # FastAPI backend
│   └── requirements.txt   # Python dependencies
├── web/
│   ├── index.html         # Main HTML page
│   ├── css/
│   │   └── style.css      # Styles
│   └── js/
│       └── treemap.js     # Main visualization logic
├── data/
│   └── *.db              # Generated SQLite databases (gitignored)
├── README.md             # User documentation
├── AGENTS.md             # This file
└── CONTRIBUTORS.md       # License information
```

## Debugging Tips

1. **Preprocessor Issues**: 
   - Add `print()` statements in the processing loop
   - Check database with SQLite browser to verify data

2. **Server Issues**:
   - Use FastAPI auto-docs at `/docs` to test API endpoints
   - Check server logs for SQL errors
   - Use `--reload` flag for auto-restart during development

3. **Frontend Issues**:
   - Open browser DevTools console (F12)
   - Check Network tab for failed API calls
   - Add `console.log()` in event handlers
   - Inspect SVG elements to verify rendering

4. **Performance Issues**:
   - Check SQL query execution time in backend
   - Profile JavaScript with browser DevTools
   - Reduce viewport size if too many tiles rendering
   - Check database file size and indexes

## Contributing

When modifying the codebase:

1. Maintain consistent code style (4 spaces, descriptive names)
2. Add comments for complex algorithms
3. Test with small and large repositories
4. Update this documentation if changing architecture
5. Keep dependencies minimal
6. Follow separation of concerns (preprocessor → server → frontend)

---

**Last Updated**: 2025-11-03  
**Lines of Code**: ~2000 total (271 preprocessor + 368 server + 1343 frontend)
