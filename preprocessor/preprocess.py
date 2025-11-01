#!/usr/bin/env python3
"""
Preprocessor for repovis - analyzes git repository and generates SQLite database
"""

import argparse
import sqlite3
import sys
from pathlib import Path
from datetime import datetime
from collections import defaultdict

from git import Repo
from tqdm import tqdm


class RepoPreprocessor:
    def __init__(self, repo_path: str, output_db: str):
        self.repo_path = Path(repo_path)
        self.output_db = output_db
        self.repo = None
        self.conn = None
        self.cursor = None
        
        # In-memory caches for lookups
        self.file_cache = {}  # path -> file_id
        self.contributor_cache = {}  # email -> contributor_id
        
    def initialize_db(self):
        """Create database and schema"""
        print(f"Initializing database: {self.output_db}")
        self.conn = sqlite3.connect(self.output_db)
        self.cursor = self.conn.cursor()
        
        # Load schema
        schema_path = Path(__file__).parent / "schema.sql"
        with open(schema_path) as f:
            self.cursor.executescript(f.read())
        
        self.conn.commit()
        
    def open_repo(self):
        """Open git repository"""
        print(f"Opening repository: {self.repo_path}")
        try:
            self.repo = Repo(self.repo_path)
        except Exception as e:
            print(f"Error opening repository: {e}", file=sys.stderr)
            sys.exit(1)
            
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
        
        # Determine if it's a directory based on path structure
        is_directory = path.endswith('/')
        clean_path = path.rstrip('/')
        
        # Get parent
        parent_id = None
        if '/' in clean_path:
            parent_path = '/'.join(clean_path.split('/')[:-1])
            if parent_path:
                parent_id = self.get_or_create_file(parent_path + '/')
        
        # Get name
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
        
        # Get all commits
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
                # Get contributor
                author_name = commit.author.name
                author_email = commit.author.email
                contributor_id = self.get_or_create_contributor(author_name, author_email)
                
                # Get date (bucketed by day)
                commit_date = datetime.fromtimestamp(commit.committed_date)
                date_str = commit_date.strftime('%Y-%m-%d')
                
                # Store commit info
                commit_batch.append((
                    commit.hexsha,
                    contributor_id,
                    date_str,
                    commit.message[:500]  # Truncate long messages
                ))
                
                # Process file changes
                if commit.parents:
                    parent = commit.parents[0]
                    diffs = parent.diff(commit)
                    
                    for diff in diffs:
                        # Get file path (handle renames, deletions)
                        file_path = diff.b_path if diff.b_path else diff.a_path
                        if not file_path:
                            continue
                        
                        file_id = self.get_or_create_file(file_path)
                        
                        # Count line changes
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
                        
                        # Update metrics
                        self.update_metrics(file_id, contributor_id, date_str, 1, lines_added, lines_deleted)
                        
                        # Also update parent directories
                        if '/' in file_path:
                            parts = file_path.split('/')
                            for i in range(1, len(parts)):
                                dir_path = '/'.join(parts[:i]) + '/'
                                dir_id = self.get_or_create_file(dir_path)
                                self.update_metrics(dir_id, contributor_id, date_str, 1, lines_added, lines_deleted)
                
                processed += 1
                
                # Commit every 1000 commits
                if processed % 1000 == 0:
                    # Insert commit batch
                    self.cursor.executemany(
                        "INSERT OR IGNORE INTO commits (sha, author_id, date, message) VALUES (?, ?, ?, ?)",
                        commit_batch
                    )
                    commit_batch = []
                    self.conn.commit()
                    
            except Exception as e:
                print(f"\nWarning: Error processing commit {commit.hexsha[:8]}: {e}")
                continue
        
        # Final commit
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
    
    def run(self):
        """Run the full preprocessing pipeline"""
        try:
            self.open_repo()
            self.initialize_db()
            self.process_commits()
            self.save_metadata()
            
            print(f"\n✓ Successfully preprocessed repository")
            print(f"  Database: {self.output_db}")
            print(f"  Contributors: {len(self.contributor_cache)}")
            print(f"  Files/Directories: {len(self.file_cache)}")
            
        finally:
            if self.conn:
                self.conn.close()


def main():
    parser = argparse.ArgumentParser(
        description='Preprocess git repository for repovis visualization'
    )
    parser.add_argument(
        'repo_path',
        help='Path to git repository'
    )
    parser.add_argument(
        '--output', '-o',
        default='../data/repo.db',
        help='Output database file (default: ../data/repo.db)'
    )
    
    args = parser.parse_args()
    
    # Create output directory if needed
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    preprocessor = RepoPreprocessor(args.repo_path, args.output)
    preprocessor.run()


if __name__ == '__main__':
    main()
