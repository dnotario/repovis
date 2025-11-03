# RepoVis

RepoVis is an interactive visualization tool for exploring Git repository history. It provides a treemap-based visualization of your codebase that shows file activity over time, helping you understand which parts of your repository change most frequently and who's working on what.

## Features

- **Interactive Treemap**: Visual representation of your repository structure where file/directory size reflects the number of files, and color intensity shows commit activity
- **Time Range Selection**: Drag a brush on the timeline to filter commits by date range
- **Contributor Filtering**: Filter commits by specific contributors with search and bulk selection
- **File Explorer**: Browse your repository structure with expandable tree view
- **Percentile-based Coloring**: Colors indicate relative activity (90th percentile = red, 10th percentile = green, 0 commits = yellow)
- **Zoom and Pan**: Click and zoom into specific directories, double-click in tree view to focus
- **Real-time Updates**: Visual feedback updates as you drag the timeline or change filters

## Installation

### Prerequisites

- Python 3.7+
- Git repository to analyze
- Modern web browser

### Steps

1. **Clone the repository**:
   ```bash
   git clone https://github.com/dnotario/repovis.git
   cd repovis
   ```

2. **Install Python dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

## Usage

RepoVis automatically handles preprocessing and serving in a single command. The database is cached in `.repovis/` within your repository root.

### Quick Start

Visualize any Git repository:

```bash
python3 repovis.py /path/to/your/git/repo
```

Then open your browser to:
```
http://127.0.0.1:8000
```

### Command Line Options

```bash
python3 repovis.py [REPO_PATH] [OPTIONS]
```

**Arguments**:
- `REPO_PATH`: Path to git repository (default: current directory)

**Options**:
- `--rebuild`: Force rebuild of database (ignores cache)
- `--preprocess-only`: Only preprocess, do not start server
- `--port, -p PORT`: Port to run server on (default: 8000)
- `--host HOST`: Host to bind to (default: 127.0.0.1)

### Examples

```bash
# Analyze current directory
python3 repovis.py

# Analyze specific repository
python3 repovis.py ~/projects/linux

# Force rebuild and use custom port
python3 repovis.py ~/projects/linux --rebuild --port 3000

# Only preprocess, don't start server
python3 repovis.py ~/projects/linux --preprocess-only

# Serve on all interfaces
python3 repovis.py --host 0.0.0.0
```

### How It Works

1. **First run**: Preprocesses the repository and creates a cached database at `.repovis/{reponame}_{hash}.db`
2. **Subsequent runs**: Uses the cached database for instant startup
3. **Updates**: Use `--rebuild` to regenerate the database after new commits

The tool automatically:
- Detects if a cached database exists
- Uses the cache for fast startup
- Rebuilds when `--rebuild` is specified
- Stores cache in `.repovis/` directory (add to `.gitignore`)

## How to Use the Visualization

### Main Interface

- **Treemap (Center)**: Shows your repository structure
  - Each rectangle represents a file (sized by file count in hierarchy)
  - Colors indicate commit activity in the selected time range:
    - 🟡 Yellow: 0 commits (no activity)
    - 🟢 Green: Low activity (bottom percentile)
    - 🟠 Orange/Yellow: Medium activity
    - 🔴 Red: High activity (top percentile)
  - Click and drag to pan
  - Scroll to zoom
  - Click on a directory/file to highlight it

- **File Tree (Left Panel)**:
  - Browse repository structure
  - Click chevron (▸/▾) to expand/collapse directories
  - Click file/directory name to highlight in treemap
  - Double-click directory to zoom treemap to that directory
  - Search bar filters the tree view

- **Contributors Panel (Right Panel)**:
  - List of all contributors who made commits
  - Search to filter contributors
  - Check/uncheck to include/exclude their commits
  - "Select All" and "Clear All" buttons for bulk operations

- **Timeline (Bottom)**:
  - Shows commit activity over time
  - Drag the brush handles to select a time range
  - Selected dates appear above the timeline
  - Treemap updates in real-time as you drag

### Keyboard and Mouse

- **Pan**: Click and drag on the treemap
- **Zoom**: Scroll wheel on the treemap
- **Reset**: Scroll to zoom out fully
- **Navigate**: Click on directories in the file tree
- **Quick Zoom**: Double-click a directory name in the file tree

## Database Schema

The tool generates a SQLite database in `.repovis/` with the following structure:

- `files`: File/directory hierarchy with paths, parent relationships, and names
- `contributors`: List of contributors with name and email
- `file_metrics`: Daily aggregated metrics per file and contributor (commit count, lines added/deleted)
- `commits`: Commit records with SHA, author, date, and message
- `metadata`: Repository information (path, HEAD SHA, processed timestamp, counts)

## Cache Management

- **Location**: `.repovis/{reponame}_{gitdirhash}.db` in repository root
- **Naming**: Combines repo name and path hash for uniqueness
- **Rebuild**: Always performs full rebuild (no incremental updates)
- **Cleanup**: Safe to delete `.repovis/` directory to clear cache

**Tip**: Add `.repovis/` to your `.gitignore`

## Performance Tips

- For very large repositories (>100k commits), preprocessing may take 10-30 minutes
- The web interface handles repositories with thousands of files efficiently
- Filtering by contributors or time range happens server-side via SQL queries
- Only visible tiles are rendered in the treemap for optimal performance

## Troubleshooting

**"Error opening repository"**:
- Ensure the path is a valid Git repository
- Check you have read permissions for the directory

**"Database not found"**:
- The cache was not created. Try running with `--rebuild`
- Check you have write permissions in the repository directory

**Port already in use**:
- Use `--port` to specify a different port
- Or stop the existing process: `lsof -ti:8000 | xargs kill`

**Preprocessing is slow**:
- Large repositories (>100k commits) may take 10-30 minutes
- This only happens once; subsequent runs use the cache
- Progress is shown with a progress bar

**Visualization doesn't load**:
- Check browser console for errors (F12)
- Verify the server is running on the expected port
- Try a different modern browser (Chrome, Firefox, Safari, Edge)

**Database is stale**:
- Use `--rebuild` to regenerate after pulling new commits

## License

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for license information.

## Technical Documentation

For architecture and implementation details, see [AGENTS.md](AGENTS.md).
