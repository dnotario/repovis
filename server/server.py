#!/usr/bin/env python3
"""
FastAPI server for repovis - serves preprocessed git repository data
"""

import argparse
import sqlite3
from pathlib import Path
from typing import List, Optional, Dict, Any
from datetime import datetime

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn


app = FastAPI(title="repovis API", version="0.1.0")

# Enable CORS for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global database connection
db_path: str = None
web_dir: Path = None


def get_db():
    """Get database connection"""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


@app.get("/")
async def root():
    """Serve main UI"""
    index_path = web_dir / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return {"message": "repovis API", "docs": "/docs"}


@app.get("/api/metadata")
async def get_metadata():
    """Get repository metadata"""
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("SELECT key, value FROM metadata")
    metadata = {row['key']: row['value'] for row in cursor.fetchall()}
    
    conn.close()
    return metadata


@app.get("/api/tree")
async def get_tree(
    start_date: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end_date: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    contributors: Optional[str] = Query(None, description="Comma-separated contributor IDs"),
    metric: str = Query("commit_count", description="Metric type: commit_count, lines_added, lines_deleted")
):
    """
    Get file tree structure with metrics embedded.
    If date range provided, includes metrics for that period.
    """
    conn = get_db()
    cursor = conn.cursor()
    
    # Get all files
    cursor.execute("""
        SELECT id, path, parent_id, name, is_directory
        FROM files
        ORDER BY path
    """)
    
    files = []
    file_ids = []
    for row in cursor.fetchall():
        file_data = {
            'id': row['id'],
            'path': row['path'],
            'parent_id': row['parent_id'],
            'name': row['name'],
            'is_directory': bool(row['is_directory'])
        }
        files.append(file_data)
        file_ids.append(row['id'])
    
    # Get metrics if date range provided
    metrics_map = {}
    if start_date and end_date:
        query = """
            SELECT 
                file_id,
                SUM(commit_count) as total_commits,
                SUM(lines_added) as total_lines_added,
                SUM(lines_deleted) as total_lines_deleted
            FROM file_metrics
            WHERE date >= ? AND date <= ?
        """
        
        params = [start_date, end_date]
        
        # Filter by contributors if provided
        if contributors:
            contributor_ids = [int(c.strip()) for c in contributors.split(',') if c.strip()]
            if contributor_ids:
                placeholders = ','.join('?' * len(contributor_ids))
                query += f" AND contributor_id IN ({placeholders})"
                params.extend(contributor_ids)
        
        query += " GROUP BY file_id"
        
        cursor.execute(query, params)
        
        for row in cursor.fetchall():
            # Select the requested metric
            if metric == "commit_count":
                value = row['total_commits']
            elif metric == "lines_added":
                value = row['total_lines_added']
            elif metric == "lines_deleted":
                value = row['total_lines_deleted']
            else:
                value = row['total_commits']
            
            metrics_map[row['file_id']] = {
                'commit_count': row['total_commits'],
                'lines_added': row['total_lines_added'],
                'lines_deleted': row['total_lines_deleted'],
                'value': value  # The selected metric
            }
    
    # Attach metrics to files
    for file_data in files:
        if file_data['id'] in metrics_map:
            file_data['metrics'] = metrics_map[file_data['id']]
        else:
            file_data['metrics'] = None
    
    # Get date range
    cursor.execute("""
        SELECT MIN(date) as min_date, MAX(date) as max_date
        FROM commits
    """)
    date_row = cursor.fetchone()
    
    conn.close()
    
    return {
        'files': files,
        'date_range': {
            'min_date': date_row['min_date'],
            'max_date': date_row['max_date']
        },
        'metric_type': metric
    }


@app.get("/api/contributors")
async def get_contributors():
    """Get all contributors"""
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT id, name, email
        FROM contributors
        ORDER BY name
    """)
    
    contributors = []
    for row in cursor.fetchall():
        contributors.append({
            'id': row['id'],
            'name': row['name'],
            'email': row['email']
        })
    
    conn.close()
    return {'contributors': contributors}


@app.get("/api/timeline")
async def get_timeline(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
):
    """Get commit timeline (histogram of commits by date)"""
    conn = get_db()
    cursor = conn.cursor()
    
    query = """
        SELECT date, COUNT(*) as count
        FROM commits
    """
    
    params = []
    conditions = []
    
    if start_date:
        conditions.append("date >= ?")
        params.append(start_date)
    
    if end_date:
        conditions.append("date <= ?")
        params.append(end_date)
    
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    
    query += " GROUP BY date ORDER BY date"
    
    cursor.execute(query, params)
    
    timeline = []
    for row in cursor.fetchall():
        timeline.append({
            'date': row['date'],
            'count': row['count']
        })
    
    conn.close()
    return {'timeline': timeline}





@app.get("/api/file/{file_id}")
async def get_file_details(file_id: int):
    """Get details about a specific file"""
    conn = get_db()
    cursor = conn.cursor()
    
    # Get file info
    cursor.execute("""
        SELECT id, path, parent_id, name, is_directory
        FROM files
        WHERE id = ?
    """, (file_id,))
    
    row = cursor.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="File not found")
    
    file_info = {
        'id': row['id'],
        'path': row['path'],
        'parent_id': row['parent_id'],
        'name': row['name'],
        'is_directory': bool(row['is_directory'])
    }
    
    # Get top contributors for this file
    cursor.execute("""
        SELECT 
            c.id,
            c.name,
            c.email,
            SUM(fm.commit_count) as total_commits
        FROM file_metrics fm
        JOIN contributors c ON fm.contributor_id = c.id
        WHERE fm.file_id = ?
        GROUP BY c.id
        ORDER BY total_commits DESC
        LIMIT 10
    """, (file_id,))
    
    top_contributors = []
    for row in cursor.fetchall():
        top_contributors.append({
            'id': row['id'],
            'name': row['name'],
            'email': row['email'],
            'commits': row['total_commits']
        })
    
    file_info['top_contributors'] = top_contributors
    
    conn.close()
    return file_info








def main():
    global db_path, web_dir
    
    parser = argparse.ArgumentParser(
        description='Start repovis web server'
    )
    parser.add_argument(
        '--data', '-d',
        default='../data/repo.db',
        help='Path to preprocessed database file'
    )
    parser.add_argument(
        '--port', '-p',
        type=int,
        default=8000,
        help='Port to run server on (default: 8000)'
    )
    parser.add_argument(
        '--host',
        default='127.0.0.1',
        help='Host to bind to (default: 127.0.0.1)'
    )
    
    args = parser.parse_args()
    
    # Check database exists
    db_path = args.data
    if not Path(db_path).exists():
        print(f"Error: Database file not found: {db_path}")
        print("Run the preprocessor first to generate the database.")
        return 1
    
    # Set web directory
    web_dir = Path(__file__).parent.parent / "web"
    
    # Mount static files if web directory exists
    if web_dir.exists():
        app.mount("/static", StaticFiles(directory=web_dir), name="static")
    
    print(f"Starting repovis server...")
    print(f"  Database: {db_path}")
    print(f"  URL: http://{args.host}:{args.port}")
    print(f"  API docs: http://{args.host}:{args.port}/docs")
    
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == '__main__':
    main()
