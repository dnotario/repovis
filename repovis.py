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
    def __init__(self, repo_path: str, since: str = None, until: str = None):
        self.repo_path = Path(repo_path).resolve()
        self.repo = None
        self.db_path = None
        self.conn = None
        self.cursor = None
        self.since = since
        self.until = until
        
        # In-memory caches for lookups
        self.file_cache = {}
        self.contributor_cache = {}
        
    def get_cache_db_path(self) -> Path:
        """Generate cache DB path: .repovis/reponame_gitdirhash[_dates].db"""
        repo_name = self.repo_path.name
        git_dir_hash = hashlib.sha256(str(self.repo_path).encode()).hexdigest()[:16]
        
        cache_dir = self.repo_path / ".repovis"
        cache_dir.mkdir(exist_ok=True)
        
        # Include date range in filename if specified
        if self.since or self.until:
            since_str = self.since.replace('-', '') if self.since else 'start'
            until_str = self.until.replace('-', '') if self.until else 'end'
            db_name = f"{repo_name}_{git_dir_hash}_{since_str}_{until_str}.db"
        else:
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
                       commit_count: int = 1):
        """Update or insert file metrics"""
        self.cursor.execute("""
            INSERT INTO file_metrics (file_id, contributor_id, date, commit_count, lines_added, lines_deleted)
            VALUES (?, ?, ?, ?, 0, 0)
            ON CONFLICT(file_id, contributor_id, date) 
            DO UPDATE SET 
                commit_count = commit_count + ?
        """, (file_id, contributor_id, date, commit_count, commit_count))
    
    def process_commits(self):
        """Process commits in the repository (optionally filtered by date range)"""
        print("Processing commits...")
        
        # Build git log command for single-pass processing
        git_cmd = ['git', 'log', '--all', '--pretty=format:%H%x00%an%x00%ae%x00%at%x00%s', '--name-only', '--no-merges']
        
        if self.since:
            git_cmd.append(f'--since={self.since}')
        if self.until:
            git_cmd.append(f'--until={self.until}')
        
        if self.since or self.until:
            date_info = f" (from {self.since or 'beginning'} to {self.until or 'now'})"
        else:
            date_info = ""
        
        print(f"Running git log{date_info}...")
        
        import subprocess
        result = subprocess.run(git_cmd, cwd=self.repo_path, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"Error running git log: {result.stderr}", file=sys.stderr)
            sys.exit(1)
        
        # Parse output
        lines = result.stdout.strip().split('\n')
        
        processed = 0
        commit_batch = []
        file_batch = set()
        metrics_accumulator = defaultdict(int)  # {(file_path, contributor_id, date): count}
        
        i = 0
        total_lines = len(lines)
        
        with tqdm(total=total_lines, desc="Processing commits", unit=" lines") as pbar:
            while i < total_lines:
                if not lines[i]:
                    i += 1
                    pbar.update(1)
                    continue
                
                # Parse commit header: SHA\0name\0email\0timestamp\0message
                parts = lines[i].split('\x00')
                if len(parts) < 5:
                    i += 1
                    pbar.update(1)
                    continue
                
                sha, author_name, author_email, timestamp, message = parts[0], parts[1], parts[2], parts[3], '\x00'.join(parts[4:])
                contributor_id = self.get_or_create_contributor(author_name, author_email)
                
                commit_date = datetime.fromtimestamp(int(timestamp))
                date_str = commit_date.strftime('%Y-%m-%d')
                
                commit_batch.append((sha, contributor_id, date_str, message[:500]))
                
                # Get file list (lines after commit header until blank line or next commit)
                i += 1
                pbar.update(1)
                
                while i < total_lines and lines[i] and not '\x00' in lines[i]:
                    file_path = lines[i].strip()
                    if file_path:
                        if file_path not in self.file_cache:
                            file_batch.add(file_path)
                        
                        key = (file_path, contributor_id, date_str)
                        metrics_accumulator[key] += 1
                    
                    i += 1
                    pbar.update(1)
                
                processed += 1
                
                # Batch commit every 1000 commits
                if processed % 1000 == 0:
                    self._batch_commit_data(commit_batch, file_batch, metrics_accumulator)
                    commit_batch = []
                    file_batch = set()
                    metrics_accumulator.clear()
        
        # Final batch
        if commit_batch:
            self._batch_commit_data(commit_batch, file_batch, metrics_accumulator)
        
        print(f"\nProcessed {processed} commits")
    
    def _batch_commit_data(self, commit_batch, file_batch, metrics_accumulator):
        """Commit batched data to database"""
        if commit_batch:
            self.cursor.executemany(
                "INSERT OR IGNORE INTO commits (sha, author_id, date, message) VALUES (?, ?, ?, ?)",
                commit_batch
            )
        
        if file_batch:
            self._batch_insert_files(list(file_batch))
        
        if metrics_accumulator:
            self._batch_insert_metrics(metrics_accumulator)
        
        self.conn.commit()
    
    def _batch_insert_files(self, file_paths):
        """Batch insert files with their parent directories"""
        all_paths = set()
        for path in file_paths:
            all_paths.add(path)
            # Add all parent directories
            parts = path.rstrip('/').split('/')
            for i in range(1, len(parts)):
                parent = '/'.join(parts[:i]) + '/'
                all_paths.add(parent)
        
        # Sort by depth (parents first)
        sorted_paths = sorted(all_paths, key=lambda p: p.count('/'))
        
        for path in sorted_paths:
            if path not in self.file_cache:
                is_directory = path.endswith('/')
                clean_path = path.rstrip('/')
                
                parent_id = None
                if '/' in clean_path:
                    parent_path = '/'.join(clean_path.split('/')[:-1]) + '/'
                    parent_id = self.file_cache.get(parent_path)
                
                name = clean_path.split('/')[-1] if '/' in clean_path else clean_path
                
                self.cursor.execute(
                    "INSERT OR IGNORE INTO files (path, parent_id, name, is_directory) VALUES (?, ?, ?, ?)",
                    (path, parent_id, name, is_directory)
                )
                self.cursor.execute("SELECT id FROM files WHERE path = ?", (path,))
                result = self.cursor.fetchone()
                if result:
                    self.file_cache[path] = result[0]
    
    def _batch_insert_metrics(self, metrics_accumulator):
        """Batch insert/update metrics"""
        metrics_batch = []
        for (file_path, contributor_id, date_str), count in metrics_accumulator.items():
            file_id = self.file_cache.get(file_path)
            if file_id:
                metrics_batch.append((file_id, contributor_id, date_str, count, count))
        
        if metrics_batch:
            self.cursor.executemany("""
                INSERT INTO file_metrics (file_id, contributor_id, date, commit_count, lines_added, lines_deleted)
                VALUES (?, ?, ?, ?, 0, 0)
                ON CONFLICT(file_id, contributor_id, date) 
                DO UPDATE SET commit_count = commit_count + ?
            """, metrics_batch)
    
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
        
        # Add date range if specified
        if self.since:
            metadata['date_range_since'] = self.since
        if self.until:
            metadata['date_range_until'] = self.until
        
        for key, value in metadata.items():
            self.cursor.execute(
                "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
                (key, str(value))
            )
        
        self.conn.commit()
    
    def add_current_files(self):
        """Add current files and remove deleted files"""
        print("Syncing with current working tree...")
        
        # Collect all current files
        current_files = set()
        
        def walk_tree(tree, path=""):
            """Recursively walk git tree and collect current files"""
            for item in tree:
                item_path = f"{path}{item.name}"
                
                if item.type == 'tree':
                    # It's a directory
                    dir_path = item_path + '/'
                    current_files.add(dir_path)
                    self.get_or_create_file(dir_path)
                    # Recurse into subdirectory
                    walk_tree(item, item_path + '/')
                else:
                    # It's a file (blob)
                    current_files.add(item_path)
                    self.get_or_create_file(item_path)
        
        try:
            head_tree = self.repo.head.commit.tree
            walk_tree(head_tree)
            
            # Find and delete files that no longer exist
            all_cached = set(self.file_cache.keys())
            deleted_files = all_cached - current_files
            
            if deleted_files:
                print(f"  Removing {len(deleted_files)} deleted files from database...")
                for file_path in deleted_files:
                    file_id = self.file_cache.get(file_path)
                    if file_id:
                        # Delete file and its metrics
                        self.cursor.execute("DELETE FROM file_metrics WHERE file_id = ?", (file_id,))
                        self.cursor.execute("DELETE FROM files WHERE id = ?", (file_id,))
                        del self.file_cache[file_path]
            
            self.conn.commit()
            print(f"  Total current files/directories: {len(self.file_cache)}")
        except Exception as e:
            print(f"Warning: Could not sync current files: {e}")
    
    def preprocess(self):
        """Run preprocessing pipeline"""
        try:
            self.open_repo()
            self.db_path = self.get_cache_db_path()
            self.initialize_db()
            self.process_commits()
            self.add_current_files()
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
    parser.add_argument(
        '--since',
        help='Only process commits since this date (e.g., "2024-01-01", "6 months ago")'
    )
    parser.add_argument(
        '--until',
        help='Only process commits until this date (e.g., "2024-12-31", "yesterday")'
    )
    
    args = parser.parse_args()
    
    repovis = RepoVis(args.repo_path, since=args.since, until=args.until)
    
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
