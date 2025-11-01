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

### GET /api/tree
Get the complete file tree structure with metrics embedded.

**Query Parameters:**
- `start_date` (optional): Start date in YYYY-MM-DD format
- `end_date` (optional): End date in YYYY-MM-DD format
- `contributors` (optional): Comma-separated list of contributor IDs to filter
- `metric` (optional): Metric type - `commit_count`, `lines_added`, or `lines_deleted` (default: `commit_count`)

**Returns:**
```json
{
  "files": [
    {
      "id": 1,
      "path": "src/",
      "parent_id": null,
      "name": "src",
      "is_directory": true,
      "metrics": {
        "commit_count": 150,
        "lines_added": 5000,
        "lines_deleted": 2000,
        "value": 150
      }
    }
  ],
  "date_range": {
    "min_date": "2020-01-01",
    "max_date": "2024-12-31"
  },
  "metric_type": "commit_count"
}
```

### GET /api/contributors
Get list of all contributors.

### GET /api/timeline
Get commit histogram for timeline brush visualization.

**Query Parameters:**
- `start_date` (optional): Filter timeline from this date
- `end_date` (optional): Filter timeline to this date

**Returns:**
```json
{
  "timeline": [
    {"date": "2020-01-01", "count": 15},
    {"date": "2020-01-02", "count": 8}
  ]
}
```

### GET /api/metadata
Get repository metadata (total commits, contributors, processing info).

### GET /api/file/{file_id}
Get details about a specific file including top contributors.

## Interactive API Documentation

Visit http://localhost:8000/docs for interactive API documentation powered by Swagger UI.
