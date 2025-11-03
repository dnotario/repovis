-- SQLite schema for repovis preprocessed data

-- File tree structure
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    parent_id INTEGER,
    name TEXT NOT NULL,
    is_directory BOOLEAN NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES files(id)
);

CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);

-- Contributors
CREATE TABLE IF NOT EXISTS contributors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_contributors_email ON contributors(email);

-- Time-bucketed metrics for files/directories
-- Each row represents activity for a file in a specific time bucket
CREATE TABLE IF NOT EXISTS file_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    contributor_id INTEGER NOT NULL,
    date TEXT NOT NULL, -- ISO format YYYY-MM-DD
    commit_count INTEGER DEFAULT 0,
    lines_added INTEGER DEFAULT 0,
    lines_deleted INTEGER DEFAULT 0,
    FOREIGN KEY (file_id) REFERENCES files(id),
    FOREIGN KEY (contributor_id) REFERENCES contributors(id),
    UNIQUE(file_id, contributor_id, date)
);

CREATE INDEX IF NOT EXISTS idx_metrics_file ON file_metrics(file_id);
CREATE INDEX IF NOT EXISTS idx_metrics_date ON file_metrics(date);
CREATE INDEX IF NOT EXISTS idx_metrics_contributor ON file_metrics(contributor_id);
CREATE INDEX IF NOT EXISTS idx_metrics_file_date ON file_metrics(file_id, date);

-- Commits table for timeline/histogram
CREATE TABLE IF NOT EXISTS commits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha TEXT NOT NULL UNIQUE,
    author_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    message TEXT,
    FOREIGN KEY (author_id) REFERENCES contributors(id)
);

CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(date);
CREATE INDEX IF NOT EXISTS idx_commits_author ON commits(author_id);

-- Metadata about the repository
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT
);
