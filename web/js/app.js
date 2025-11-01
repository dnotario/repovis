// repovis - Main Application
const API_BASE = 'http://127.0.0.1:8000/api';

class RepoVis {
    constructor() {
        this.cy = null;
        this.treeData = null;
        this.contributors = [];
        this.dateRange = { min_date: null, max_date: null };
        this.selectedDateRange = { start: null, end: null };
        this.selectedContributors = [];
        this.currentMetric = 'commit_count';
        
        this.init();
    }

    async init() {
        // Load initial data
        await this.loadMetadata();
        await this.loadContributors();
        await this.loadTree();
        
        // Initialize UI components
        this.initCytoscape();
        this.initControls();
        this.initTimeline();
        
        // Render initial view
        this.renderTree();
    }

    async loadMetadata() {
        const response = await fetch(`${API_BASE}/metadata`);
        const data = await response.json();
        
        document.getElementById('repo-name').textContent = data.repo_path.split('/').pop();
        document.getElementById('stats').textContent = 
            `${data.total_commits} commits • ${data.total_contributors} contributors`;
    }

    async loadContributors() {
        const response = await fetch(`${API_BASE}/contributors`);
        const data = await response.json();
        this.contributors = data.contributors;
        
        const select = document.getElementById('contributor-select');
        this.contributors.forEach(contributor => {
            const option = document.createElement('option');
            option.value = contributor.id;
            option.textContent = `${contributor.name} (${contributor.email})`;
            select.appendChild(option);
        });
    }

    async loadTree(startDate = null, endDate = null, contributors = null, metric = 'commit_count') {
        let url = `${API_BASE}/tree`;
        const params = new URLSearchParams();
        
        if (startDate) params.append('start_date', startDate);
        if (endDate) params.append('end_date', endDate);
        if (contributors && contributors.length > 0) {
            params.append('contributors', contributors.join(','));
        }
        params.append('metric', metric);
        
        if (params.toString()) {
            url += '?' + params.toString();
        }
        
        const response = await fetch(url);
        const data = await response.json();
        
        this.treeData = data.files;
        this.dateRange = data.date_range;
        
        // Set default date range if not set
        if (!this.selectedDateRange.start) {
            this.selectedDateRange.start = this.dateRange.min_date;
            this.selectedDateRange.end = this.dateRange.max_date;
            document.getElementById('start-date').value = this.dateRange.min_date;
            document.getElementById('end-date').value = this.dateRange.max_date;
        }
    }

    initCytoscape() {
        this.cy = cytoscape({
            container: document.getElementById('cy'),
            style: [
                {
                    selector: 'node',
                    style: {
                        'label': 'data(name)',
                        'text-valign': 'center',
                        'text-halign': 'right',
                        'text-margin-x': 10,
                        'font-size': '11px',
                        'color': '#e0e0e0',
                        'background-color': 'data(color)',
                        'width': 'data(size)',
                        'height': 'data(size)',
                        'border-width': 2,
                        'border-color': '#3a3a3a',
                        'text-background-color': '#1e1e1e',
                        'text-background-opacity': 0.8,
                        'text-background-padding': '3px'
                    }
                },
                {
                    selector: 'edge',
                    style: {
                        'width': 2,
                        'line-color': '#3a3a3a',
                        'target-arrow-color': '#3a3a3a',
                        'curve-style': 'bezier'
                    }
                },
                {
                    selector: 'node:selected',
                    style: {
                        'border-color': '#4a9eff',
                        'border-width': 3
                    }
                }
            ],
            layout: {
                name: 'breadthfirst',
                directed: true,
                spacingFactor: 1.5,
                animate: false
            },
            wheelSensitivity: 0.2
        });

        // Click handler
        this.cy.on('tap', 'node', (evt) => {
            const node = evt.target;
            this.showFileDetails(node.data('fileData'));
        });
    }

    initControls() {
        document.getElementById('apply-filters').addEventListener('click', () => {
            this.applyFilters();
        });

        document.getElementById('metric-select').addEventListener('change', (e) => {
            this.currentMetric = e.target.value;
            this.applyFilters();
        });

        document.getElementById('reset-view').addEventListener('click', () => {
            this.resetView();
        });
    }

    resetView() {
        // Reset zoom and pan to fit all nodes
        this.cy.fit(null, 80);
    }

    async applyFilters() {
        const startDate = document.getElementById('start-date').value;
        const endDate = document.getElementById('end-date').value;
        const contributorSelect = document.getElementById('contributor-select');
        const selectedOptions = Array.from(contributorSelect.selectedOptions)
            .map(opt => opt.value)
            .filter(v => v !== '');
        
        this.selectedDateRange.start = startDate;
        this.selectedDateRange.end = endDate;
        this.selectedContributors = selectedOptions;
        
        await this.loadTree(startDate, endDate, selectedOptions, this.currentMetric);
        this.renderTree();
    }

    renderTree() {
        if (!this.treeData) return;

        // Calculate max metric value for color scaling
        const maxValue = Math.max(...this.treeData
            .filter(f => f.metrics)
            .map(f => f.metrics.value), 1);

        // Build nodes and edges
        const elements = [];
        const rootNodes = this.treeData.filter(f => f.parent_id === null);

        this.treeData.forEach(file => {
            const value = file.metrics ? file.metrics.value : 0;
            const intensity = value / maxValue;
            
            // Color scale: gray -> blue -> red
            let color;
            if (value === 0 || !file.metrics) {
                color = '#2a2a2a';
            } else if (intensity < 0.5) {
                // Gray to blue
                const t = intensity * 2;
                color = this.interpolateColor('#2a2a2a', '#4a9eff', t);
            } else {
                // Blue to red
                const t = (intensity - 0.5) * 2;
                color = this.interpolateColor('#4a9eff', '#ff6b6b', t);
            }

            // Size based on whether it's a directory and metric value
            const baseSize = file.is_directory ? 30 : 20;
            const size = baseSize + (intensity * 20);

            elements.push({
                data: {
                    id: `node-${file.id}`,
                    name: file.name,
                    color: color,
                    size: size,
                    fileData: file
                }
            });

            // Add edge to parent
            if (file.parent_id !== null) {
                elements.push({
                    data: {
                        id: `edge-${file.id}`,
                        source: `node-${file.parent_id}`,
                        target: `node-${file.id}`
                    }
                });
            }
        });

        // Update graph
        this.cy.elements().remove();
        this.cy.add(elements);
        
        // Custom layout: tree from left to right with better spacing
        const layout = this.cy.layout({
            name: 'breadthfirst',
            directed: true,
            roots: rootNodes.map(f => `node-${f.id}`),
            padding: 50,
            spacingFactor: 2.5, // More space between levels
            nodeDimensionsIncludeLabels: true, // Account for label width
            animate: false,
            fit: true,
            avoidOverlap: true,
            maximal: false // Keep siblings close vertically
        });
        
        layout.run();

        // After layout, adjust positions to ensure labels don't overlap
        this.adjustNodePositions();
        
        // Fit to view
        this.cy.fit(null, 80);
    }

    adjustNodePositions() {
        // Get nodes by depth level
        const levels = {};
        this.cy.nodes().forEach(node => {
            const depth = this.getNodeDepth(node);
            if (!levels[depth]) levels[depth] = [];
            levels[depth].push(node);
        });

        // For each level, space nodes vertically with enough room for labels
        Object.keys(levels).forEach(depth => {
            const nodes = levels[depth];
            
            // Sort by current y position
            nodes.sort((a, b) => a.position().y - b.position().y);
            
            // Minimum vertical spacing (adjust based on node size + label)
            let currentY = nodes[0].position().y;
            nodes.forEach(node => {
                const pos = node.position();
                node.position({ x: pos.x, y: currentY });
                
                // Space based on node size
                const nodeSize = node.data('size') || 30;
                currentY += nodeSize + 40; // 40px vertical spacing between nodes
            });
        });
    }

    getNodeDepth(node) {
        let depth = 0;
        let current = node;
        while (current.incomers('node').length > 0) {
            current = current.incomers('node')[0];
            depth++;
        }
        return depth;
    }

    interpolateColor(color1, color2, factor) {
        const c1 = parseInt(color1.slice(1), 16);
        const c2 = parseInt(color2.slice(1), 16);
        
        const r1 = (c1 >> 16) & 0xff;
        const g1 = (c1 >> 8) & 0xff;
        const b1 = c1 & 0xff;
        
        const r2 = (c2 >> 16) & 0xff;
        const g2 = (c2 >> 8) & 0xff;
        const b2 = c2 & 0xff;
        
        const r = Math.round(r1 + (r2 - r1) * factor);
        const g = Math.round(g1 + (g2 - g1) * factor);
        const b = Math.round(b1 + (b2 - b1) * factor);
        
        return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
    }

    async initTimeline() {
        const response = await fetch(`${API_BASE}/timeline`);
        const data = await response.json();
        
        if (!data.timeline || data.timeline.length === 0) return;

        const margin = { top: 10, right: 20, bottom: 30, left: 40 };
        const container = document.getElementById('timeline-container');
        const width = container.clientWidth - margin.left - margin.right;
        const height = 80 - margin.top - margin.bottom;

        const svg = d3.select('#timeline')
            .attr('width', width + margin.left + margin.right)
            .attr('height', height + margin.top + margin.bottom)
            .append('g')
            .attr('transform', `translate(${margin.left},${margin.top})`);

        // Parse dates
        const parseDate = d3.timeParse('%Y-%m-%d');
        data.timeline.forEach(d => {
            d.date = parseDate(d.date);
        });

        // Scales
        const x = d3.scaleTime()
            .domain(d3.extent(data.timeline, d => d.date))
            .range([0, width]);

        const y = d3.scaleLinear()
            .domain([0, d3.max(data.timeline, d => d.count)])
            .range([height, 0]);

        // Bars
        svg.selectAll('.timeline-bar')
            .data(data.timeline)
            .enter()
            .append('rect')
            .attr('class', 'timeline-bar')
            .attr('x', d => x(d.date))
            .attr('y', d => y(d.count))
            .attr('width', Math.max(width / data.timeline.length - 1, 1))
            .attr('height', d => height - y(d.count));

        // X axis
        svg.append('g')
            .attr('class', 'timeline-axis')
            .attr('transform', `translate(0,${height})`)
            .call(d3.axisBottom(x).ticks(6));

        // Brush for date range selection
        const brush = d3.brushX()
            .extent([[0, 0], [width, height]])
            .on('end', (event) => {
                if (!event.selection) return;
                
                const [x0, x1] = event.selection;
                const startDate = x.invert(x0);
                const endDate = x.invert(x1);
                
                document.getElementById('start-date').value = 
                    d3.timeFormat('%Y-%m-%d')(startDate);
                document.getElementById('end-date').value = 
                    d3.timeFormat('%Y-%m-%d')(endDate);
                
                this.applyFilters();
            });

        svg.append('g')
            .attr('class', 'timeline-brush')
            .call(brush);
    }

    showFileDetails(fileData) {
        const infoContent = document.getElementById('info-content');
        
        let html = `
            <p><strong>Path:</strong> ${fileData.path}</p>
            <p><strong>Type:</strong> ${fileData.is_directory ? 'Directory' : 'File'}</p>
        `;
        
        if (fileData.metrics) {
            html += `
                <p><strong>Commits:</strong> ${fileData.metrics.commit_count}</p>
                <p><strong>Lines Added:</strong> ${fileData.metrics.lines_added}</p>
                <p><strong>Lines Deleted:</strong> ${fileData.metrics.lines_deleted}</p>
            `;
        } else {
            html += '<p><em>No activity in selected time range</em></p>';
        }
        
        infoContent.innerHTML = html;
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new RepoVis();
});
