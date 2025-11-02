const API_BASE = 'http://127.0.0.1:8000/api';

class TreemapVis {
    constructor() {
        this.treeData = null;
        this.currentMetric = 'commit_count';
        this.currentRoot = null;
        this.width = 0;
        this.height = 0;
        
        this.init();
    }

    async init() {
        // Load data
        await this.loadData();
        
        // Setup visualization
        this.setupTreemap();
        
        // Setup controls
        this.setupControls();
        
        // Initial render
        this.render();
    }

    async loadData() {
        try {
            const response = await fetch(`${API_BASE}/tree`);
            const data = await response.json();
            this.treeData = data.files; // API returns { files: [...] }
            console.log('Data loaded:', this.treeData.length, 'files');
        } catch (error) {
            console.error('Error loading data:', error);
        }
    }

    setupTreemap() {
        const container = document.getElementById('treemap');
        this.width = container.clientWidth;
        this.height = container.clientHeight;

        this.svg = d3.select('#treemap')
            .append('svg')
            .attr('width', this.width)
            .attr('height', this.height);

        this.g = this.svg.append('g');

        // Add zoom and pan behavior
        const zoom = d3.zoom()
            .scaleExtent([0.5, 10])  // Allow zoom from 0.5x to 10x
            .on('zoom', (event) => {
                this.g.attr('transform', event.transform);
            });

        this.svg.call(zoom);
    }

    setupControls() {
        document.getElementById('reset-btn').addEventListener('click', () => {
            this.currentRoot = null;
            this.render();
        });

        document.getElementById('metric-select').addEventListener('change', (e) => {
            this.currentMetric = e.target.value;
            this.render();
        });
    }

    buildHierarchy(files) {
        // Create a map for quick lookup
        const fileMap = {};
        files.forEach(f => {
            fileMap[f.id] = {
                ...f,
                children: []
            };
        });

        // Build hierarchy
        const roots = [];
        files.forEach(f => {
            const node = fileMap[f.id];
            if (f.parent_id === null) {
                roots.push(node);
            } else if (fileMap[f.parent_id]) {
                fileMap[f.parent_id].children.push(node);
            }
        });

        // Return single root or create wrapper
        if (roots.length === 1) {
            return roots[0];
        } else {
            return {
                name: 'root',
                is_directory: true,
                children: roots
            };
        }
    }

    render() {
        if (!this.treeData) return;

        // Build hierarchy
        const hierarchyData = this.buildHierarchy(this.treeData);
        
        // Create d3 hierarchy
        const root = d3.hierarchy(hierarchyData)
            .sum(d => {
                if (!d.is_directory) {
                    return d.metrics ? d.metrics.value : 1;
                }
                return 0;
            })
            .sort((a, b) => b.value - a.value);

        // If we have a current root (zoomed in), use it
        const displayRoot = this.currentRoot || root;

        // Create treemap layout
        d3.treemap()
            .size([this.width, this.height])
            .padding(1)
            .round(true)
            (displayRoot);

        // Calculate max value for color scale
        const maxValue = d3.max(displayRoot.descendants(), d => 
            d.data.metrics ? d.data.metrics.value : 0
        );

        // Color scale
        const color = d3.scaleSequential([0, maxValue], d3.interpolateCool);

        // Clear previous
        this.g.selectAll('*').remove();

        // Create cells
        const cell = this.g.selectAll('g')
            .data(displayRoot.descendants())
            .join('g')
            .attr('transform', d => `translate(${d.x0},${d.y0})`)
            .attr('class', 'node');

        // Add rectangles
        cell.append('rect')
            .attr('width', d => d.x1 - d.x0)
            .attr('height', d => d.y1 - d.y0)
            .attr('fill', d => {
                if (!d.children) {
                    return d.data.metrics ? color(d.data.metrics.value) : '#30363d';
                }
                return '#21262d';
            })
            .attr('stroke', '#0d1117')
            .attr('stroke-width', 2)
            .on('click', (event, d) => {
                event.stopPropagation();
                this.clicked(d);
            })
            .on('mouseover', (event, d) => {
                this.showInfo(d);
            });

        // Add labels
        cell.append('text')
            .attr('class', 'node-label')
            .attr('x', 4)
            .attr('y', 13)
            .text(d => {
                const width = d.x1 - d.x0;
                const height = d.y1 - d.y0;
                if (width > 50 && height > 20) {
                    return d.data.name;
                }
                return '';
            });

        // Update breadcrumb
        this.updateBreadcrumb(displayRoot);
    }

    clicked(d) {
        if (d.children && d.value > 0) {
            // Zoom into this directory (only if it has a value)
            this.currentRoot = d;
            this.render();
        } else {
            // Show file details
            this.showInfo(d);
        }
    }

    updateBreadcrumb(node) {
        const path = [];
        let current = node;
        while (current) {
            path.unshift(current.data.name || 'root');
            current = current.parent;
        }

        const breadcrumb = document.getElementById('breadcrumb');
        breadcrumb.innerHTML = path.map((name, i) => {
            if (i === path.length - 1) {
                return `<span style="color: #c9d1d9">${name}</span>`;
            }
            return `<span onclick="treemapVis.navigateToLevel(${i})">${name}</span>`;
        }).join(' / ');
    }

    navigateToLevel(level) {
        if (level === 0) {
            this.currentRoot = null;
            this.render();
            return;
        }

        // Navigate to specific level in hierarchy
        let current = this.currentRoot;
        let targetLevel = this.currentRoot ? this.currentRoot.depth : 0;
        
        while (current && current.depth > level) {
            current = current.parent;
        }

        this.currentRoot = current;
        this.render();
    }

    showInfo(d) {
        const info = document.getElementById('file-info');
        const data = d.data;

        let html = `<div><strong>Name:</strong> ${data.name}</div>`;
        html += `<div><strong>Type:</strong> ${data.is_directory ? 'Directory' : 'File'}</div>`;
        html += `<div><strong>Path:</strong> ${data.path || 'N/A'}</div>`;
        
        if (data.metrics) {
            html += `<div><strong>Commits:</strong> ${data.metrics.value || 0}</div>`;
            html += `<div><strong>Lines:</strong> ${data.metrics.line_count || 0}</div>`;
            html += `<div><strong>Contributors:</strong> ${data.metrics.unique_contributors || 0}</div>`;
            
            if (data.metrics.last_modified) {
                const date = new Date(data.metrics.last_modified);
                html += `<div><strong>Last Modified:</strong> ${date.toLocaleDateString()}</div>`;
            }
        }

        if (d.value) {
            html += `<div><strong>Total Value:</strong> ${d.value.toFixed(0)}</div>`;
        }

        info.innerHTML = html;
    }
}

// Initialize
let treemapVis;
window.addEventListener('DOMContentLoaded', () => {
    treemapVis = new TreemapVis();
});
