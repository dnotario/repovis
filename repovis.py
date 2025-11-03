#!/usr/bin/env python3
"""
repovis - Unified tool for preprocessing and serving git repository visualizations
"""

import argparse
import hashlib
import sqlite3
import sys
from pathlib import Path
from datetime import datetime
from collections import defaultdict

from git import Repo
from tqdm import tqdm
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn


class RepoVis:
    def __init__(self, repo_path: str):
        self.repo_path = Path(repo_path).resolve()
        self.repo = None
        self.db_path = None
        self.conn = None
        self.cursor = None
        
        # In-memory caches for lookups
        self.file_cache = {}
        self.contributor_cache = {}
        
    def get_cache_db_path(self) -> Path:
        """Generate cache DB path: .repovis/reponame_gitdirhash.db"""
        repo_name = self.repo_path.name
        git_dir_hash = hashlib.sha256(str(self.repo_path).encode()).hexdigest()[:16]
        
        cache_dir = self.repo_path / ".repovis"
        cache_dir.mkdir(exist_ok=True)
        
        db_name = f"{repo_name}_{git_dir_hash}.db"
        return cache_dir / db_name
    
    def open_repo(self):
        """Open git repository"""
        try:
            self.repo = Repo(self.repo_path)
        except Exception as e:
            print(f"Error opening repository: {e}", file=sys.stderr)
            sys.exit(1)
    
    def initialize_db(self):
        """Create database and schema"""
        print(f"Initializing database: {self.db_path}")
        
        # Remove old DB if exists
        if self.db_path.exists():
            self.db_path.unlink()
        
        self.conn = sqlite3.connect(self.db_path)
        self.cursor = self.conn.cursor()
        
        # Load schema
        schema_path = Path(__file__).parent / "schema.sql"
        with open(schema_path) as f:
            self.cursor.executescript(f.read())
        
        self.conn.commit()
    
    def get_or_create_contributor(self, name: str, email: str) -> int:
        """Get or create contributor, return ID"""
        if email in self.contributor_cache:
            return self.contributor_cache[email]
        
        self.cursor.execute(
            "INSERT OR IGNORE INTO contributors (name, email) VALUES (?, ?)",
            (name, email)
        )
        self.cursor.execute("SELECT id FROM contributors WHERE email = ?", (email,))
        contributor_id = self.cursor.fetchone()[0]
        self.contributor_cache[email] = contributor_id
        return contributor_id
    
    def get_or_create_file(self, path: str) -> int:
        """Get or create file entry, return ID. Creates parent directories as needed."""
        if path in self.file_cache:
            return self.file_cache[path]
        
        is_directory = path.endswith('/')
        clean_path = path.rstrip('/')
        
        parent_id = None
        if '/' in clean_path:
            parent_path = '/'.join(clean_path.split('/')[:-1])
            if parent_path:
                parent_id = self.get_or_create_file(parent_path + '/')
        
        name = clean_path.split('/')[-1] if '/' in clean_path else clean_path
        
        self.cursor.execute(
            "INSERT OR IGNORE INTO files (path, parent_id, name, is_directory) VALUES (?, ?, ?, ?)",
            (path, parent_id, name, is_directory)
        )
        self.cursor.execute("SELECT id FROM files WHERE path = ?", (path,))
        file_id = self.cursor.fetchone()[0]
        self.file_cache[path] = file_id
        return file_id
    
    def update_metrics(self, file_id: int, contributor_id: int, date: str, 
                       commit_count: int = 1, lines_added: int = 0, lines_deleted: int = 0):
        """Update or insert file metrics"""
        self.cursor.execute("""
            INSERT INTO file_metrics (file_id, contributor_id, date, commit_count, lines_added, lines_deleted)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(file_id, contributor_id, date) 
            DO UPDATE SET 
                commit_count = commit_count + ?,
                lines_added = lines_added + ?,
                lines_deleted = lines_deleted + ?
        """, (file_id, contributor_id, date, commit_count, lines_added, lines_deleted,
              commit_count, lines_added, lines_deleted))
    
    def process_commits(self):
        """Process all commits in the repository"""
        print("Counting commits...")
        
        try:
            commits = list(self.repo.iter_commits('--all'))
        except Exception as e:
            print(f"Error getting commits: {e}", file=sys.stderr)
            sys.exit(1)
        
        total_commits = len(commits)
        print(f"Processing {total_commits} commits...")
        
        processed = 0
        commit_batch = []
        
        for commit in tqdm(commits, desc="Processing commits"):
            try:
                author_name = commit.author.name
                author_email = commit.author.email
                contributor_id = self.get_or_create_contributor(author_name, author_email)
                
                commit_date = datetime.fromtimestamp(commit.committed_date)
                date_str = commit_date.strftime('%Y-%m-%d')
                
                commit_batch.append((
                    commit.hexsha,
                    contributor_id,
                    date_str,
                    commit.message[:500]
                ))
                
                if commit.parents:
                    parent = commit.parents[0]
                    diffs = parent.diff(commit)
                    
                    for diff in diffs:
                        file_path = diff.b_path if diff.b_path else diff.a_path
                        if not file_path:
                            continue
                        
                        file_id = self.get_or_create_file(file_path)
                        
                        lines_added = 0
                        lines_deleted = 0
                        
                        if diff.diff:
                            try:
                                diff_text = diff.diff.decode('utf-8', errors='ignore')
                                for line in diff_text.split('\n'):
                                    if line.startswith('+') and not line.startswith('+++'):
                                        lines_added += 1
                                    elif line.startswith('-') and not line.startswith('---'):
                                        lines_deleted += 1
                            except:
                                pass
                        
                        self.update_metrics(file_id, contributor_id, date_str, 1, lines_added, lines_deleted)
                        
                        if '/' in file_path:
                            parts = file_path.split('/')
                            for i in range(1, len(parts)):
                                dir_path = '/'.join(parts[:i]) + '/'
                                dir_id = self.get_or_create_file(dir_path)
                                self.update_metrics(dir_id, contributor_id, date_str, 1, lines_added, lines_deleted)
                
                processed += 1
                
                if processed % 1000 == 0:
                    self.cursor.executemany(
                        "INSERT OR IGNORE INTO commits (sha, author_id, date, message) VALUES (?, ?, ?, ?)",
                        commit_batch
                    )
                    commit_batch = []
                    self.conn.commit()
                    
            except Exception as e:
                print(f"\nWarning: Error processing commit {commit.hexsha[:8]}: {e}")
                continue
        
        if commit_batch:
            self.cursor.executemany(
                "INSERT OR IGNORE INTO commits (sha, author_id, date, message) VALUES (?, ?, ?, ?)",
                commit_batch
            )
        self.conn.commit()
        
        print(f"\nProcessed {processed} commits")
    
    def save_metadata(self):
        """Save repository metadata"""
        print("Saving metadata...")
        
        metadata = {
            'repo_path': str(self.repo_path),
            'processed_at': datetime.now().isoformat(),
            'head_sha': self.repo.head.commit.hexsha,
            'total_commits': len(list(self.repo.iter_commits('--all'))),
            'total_contributors': len(self.contributor_cache),
            'total_files': len(self.file_cache)
        }
        
        for key, value in metadata.items():
            self.cursor.execute(
                "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
                (key, str(value))
            )
        
        self.conn.commit()
    
    def preprocess(self):
        """Run preprocessing pipeline"""
        try:
            self.open_repo()
            self.db_path = self.get_cache_db_path()
            self.initialize_db()
            self.process_commits()
            self.save_metadata()
            
            print(f"\n✓ Successfully preprocessed repository")
            print(f"  Database: {self.db_path}")
            print(f"  Contributors: {len(self.contributor_cache)}")
            print(f"  Files/Directories: {len(self.file_cache)}")
            
        finally:
            if self.conn:
                self.conn.close()
    
    def serve(self, host: str = "127.0.0.1", port: int = 8000):
        """Start web server"""
        self.db_path = self.get_cache_db_path()
        
        if not self.db_path.exists():
            print(f"Error: Database not found at {self.db_path}")
            print("Run with --rebuild to preprocess the repository first.")
            sys.exit(1)
        
        # Setup FastAPI app
        app = FastAPI(title="repovis API", version="0.1.0")
        
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
        
        db_path = str(self.db_path)
        web_dir = Path(__file__).parent / "web"
        
        def get_db():
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            return conn
        
        @app.get("/")
        async def root():
            index_path = web_dir / "index.html"
            if index_path.exists():
                return FileResponse(index_path)
            return {"message": "repovis API", "docs": "/docs"}
        
        @app.get("/api/metadata")
        async def get_metadata():
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute("SELECT key, value FROM metadata")
            metadata = {row['key']: row['value'] for row in cursor.fetchall()}
            conn.close()
            return metadata
        
        @app.get("/api/tree")
        async def get_tree(
            start_date: str = Query(None),
            end_date: str = Query(None),
            contributors: str = Query(None),
            exclude_contributors: str = Query(None),
            metric: str = Query("commit_count")
        ):
            conn = get_db()
            cursor = conn.cursor()
            
            cursor.execute("SELECT id, path, parent_id, name, is_directory FROM files ORDER BY path")
            
            files = []
            for row in cursor.fetchall():
                files.append({
                    'id': row['id'],
                    'path': row['path'],
                    'parent_id': row['parent_id'],
                    'name': row['name'],
                    'is_directory': bool(row['is_directory'])
                })
            
            metrics_map = {}
            if start_date and end_date:
                query = """
                    SELECT file_id,
                           SUM(commit_count) as total_commits,
                           SUM(lines_added) as total_lines_added,
                           SUM(lines_deleted) as total_lines_deleted
                    FROM file_metrics
                    WHERE date >= ? AND date <= ?
                """
                params = [start_date, end_date]
                
                if contributors:
                    contributor_ids = [int(c.strip()) for c in contributors.split(',') if c.strip()]
                    if contributor_ids:
                        placeholders = ','.join('?' * len(contributor_ids))
                        query += f" AND contributor_id IN ({placeholders})"
                        params.extend(contributor_ids)
                elif exclude_contributors:
                    excluded_ids = [int(c.strip()) for c in exclude_contributors.split(',') if c.strip()]
                    if excluded_ids:
                        placeholders = ','.join('?' * len(excluded_ids))
                        query += f" AND contributor_id NOT IN ({placeholders})"
                        params.extend(excluded_ids)
                
                query += " GROUP BY file_id"
                cursor.execute(query, params)
                
                for row in cursor.fetchall():
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
                        'value': value
                    }
            
            for file_data in files:
                file_data['metrics'] = metrics_map.get(file_data['id'])
            
            cursor.execute("SELECT MIN(date) as min_date, MAX(date) as max_date FROM commits")
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
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute("SELECT id, name, email FROM contributors ORDER BY name")
            contributors = [{'id': row['id'], 'name': row['name'], 'email': row['email']} 
                          for row in cursor.fetchall()]
            conn.close()
            return {'contributors': contributors}
        
        @app.get("/api/timeline")
        async def get_timeline(start_date: str = None, end_date: str = None):
            conn = get_db()
            cursor = conn.cursor()
            
            query = "SELECT date, COUNT(*) as count FROM commits"
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
            timeline = [{'date': row['date'], 'count': row['count']} for row in cursor.fetchall()]
            conn.close()
            return {'timeline': timeline}
        
        @app.get("/api/file/{file_id}")
        async def get_file_details(file_id: int):
            conn = get_db()
            cursor = conn.cursor()
            
            cursor.execute("SELECT id, path, parent_id, name, is_directory FROM files WHERE id = ?", (file_id,))
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
            
            cursor.execute("""
                SELECT c.id, c.name, c.email, SUM(fm.commit_count) as total_commits
                FROM file_metrics fm
                JOIN contributors c ON fm.contributor_id = c.id
                WHERE fm.file_id = ?
                GROUP BY c.id
                ORDER BY total_commits DESC
                LIMIT 10
            """, (file_id,))
            
            file_info['top_contributors'] = [
                {'id': row['id'], 'name': row['name'], 'email': row['email'], 'commits': row['total_commits']}
                for row in cursor.fetchall()
            ]
            
            conn.close()
            return file_info
        
        # Mount static files
        if web_dir.exists():
            css_dir = web_dir / "css"
            js_dir = web_dir / "js"
            if css_dir.exists():
                app.mount("/css", StaticFiles(directory=str(css_dir)), name="css")
            if js_dir.exists():
                app.mount("/js", StaticFiles(directory=str(js_dir)), name="js")
        
        print(f"Starting repovis server...")
        print(f"  Repository: {self.repo_path}")
        print(f"  Database: {self.db_path}")
        print(f"  URL: http://{host}:{port}")
        print(f"  API docs: http://{host}:{port}/docs")
        
        uvicorn.run(app, host=host, port=port)


def main():
    parser = argparse.ArgumentParser(
        description='repovis - Visualize git repository history',
        epilog='If database exists, serves immediately. Use --rebuild to regenerate.'
    )
    parser.add_argument(
        'repo_path',
        nargs='?',
        default='.',
        help='Path to git repository (default: current directory)'
    )
    parser.add_argument(
        '--rebuild',
        action='store_true',
        help='Force rebuild of database before serving'
    )
    parser.add_argument(
        '--preprocess-only',
        action='store_true',
        help='Only preprocess, do not start server'
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
    
    repovis = RepoVis(args.repo_path)
    
    # Check if DB exists
    db_path = repovis.get_cache_db_path()
    needs_rebuild = args.rebuild or not db_path.exists()
    
    if needs_rebuild:
        print(f"{'Rebuilding' if args.rebuild else 'Building'} database...")
        repovis.preprocess()
    else:
        print(f"Using cached database: {db_path}")
    
    if not args.preprocess_only:
        repovis.serve(host=args.host, port=args.port)


if __name__ == '__main__':
    main()
