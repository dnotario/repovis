# repovis Server

FastAPI server that serves the preprocessed git repository data.

## Installation

```bash
pip install -r requirements.txt
```

## Usage

```bash
python server.py --data ../data/repo.db --port 8000
```

## API Endpoints

### GET /api/metadata
Get repository metadata (total commits, contributors, etc.)

### GET /api/tree
Get the complete file tree structure

### GET /api/contributors
Get list of all contributors

### GET /api/timeline?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
Get commit histogram for timeline visualization

### GET /api/metrics?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&contributors=1,2,3&metric=commit_count
Get aggregated metrics for heatmap visualization

Parameters:
- `start_date` (required): Start date in YYYY-MM-DD format
- `end_date` (required): End date in YYYY-MM-DD format
- `contributors` (optional): Comma-separated list of contributor IDs to filter
- `metric` (optional): Metric type - `commit_count`, `lines_added`, or `lines_deleted` (default: `commit_count`)

### GET /api/file/{file_id}
Get details about a specific file including top contributors

### GET /api/date-range
Get the min and max dates available in the repository

### GET /api/stats?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&contributors=1,2,3
Get summary statistics for a time range

## Interactive API Documentation

Visit http://localhost:8000/docs for interactive API documentation powered by Swagger UI.
