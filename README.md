# repovis

A tool to visualize git repository activity over time with interactive heatmaps and contributor filtering.

## Features

- **Interactive tree visualization**: Explore your repository structure as a zoomable, pannable tree
- **Time-based heatmaps**: Select time ranges and see activity hotspots
- **Contributor filtering**: Filter by teams or individual contributors using hierarchical selection
- **Fast queries**: Pre-processed data structure for instant visualization of large repositories (tested with 1M+ commits)

## Architecture

- **Preprocessor**: Python CLI tool that analyzes git history and generates optimized SQLite database
- **Server**: Lightweight FastAPI server that serves the preprocessed data
- **Web UI**: Interactive visualization using Cytoscape.js for tree rendering

## Quick Start

### 1. Preprocess a repository

```bash
cd preprocessor
python preprocess.py /path/to/your/repo --output ../data/repo.db
```

### 2. Start the server

```bash
cd server
python server.py --data ../data/repo.db
```

### 3. Open in browser

Navigate to `http://localhost:8000`

## Project Structure

```
repovis/
├── preprocessor/     # Git analysis and data generation
├── server/          # FastAPI web server
├── web/             # Frontend (HTML/CSS/JS)
└── data/            # Generated database files (gitignored)
```

## Tech Stack

- **Backend**: Python 3.9+, GitPython, SQLite, FastAPI
- **Frontend**: Vanilla JavaScript, Cytoscape.js, D3.js (for timeline)
- **Visualization**: Cytoscape.js for tree, custom heatmap overlay

## Development Status

🚧 Work in progress
