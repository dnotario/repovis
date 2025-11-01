// repovis - Sunburst Visualization
const API_BASE = 'http://127.0.0.1:8000/api';

class RepoVis {
    constructor() {
        this.treeData = null;
        this.contributors = [];
        this.dateRange = { min_date: null, max_date: null };
        this.selectedDateRange = { start: null, end: null };
        this.selectedContributors = [];
        this.currentMetric = 'commit_count';
        this.currentRoot = null; // Track current root for drill-down
        
        this.width = 0;
        this.height = 0;
        this.radius = 0;
        
        this.init();
    }

    async init() {
        // Load initial data
        await this.loadMetadata();
        await this.loadContributors();
        await this.loadTree();
        
        // Initialize UI components
        this.initControls();
        this.initTimeline();
        this.initSunburst();
        
        // Render initial view
        this.renderSunburst();
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
            option.textContent = `${contributor.name}`;
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
        // Re-render from scratch to reset zoom
        this.currentRoot = null;
        this.renderSunburst();
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
        this.renderSunburst();
    }

    initSunburst() {
        const container = document.getElementById('visualization');
        this.width = container.clientWidth;
        this.height = container.clientHeight;
        this.radius = Math.min(this.width, this.height) / 2;

        const svg = d3.select('#sunburst')
            .attr('width', this.width)
            .attr('height', this.height)
            .attr('viewBox', [0, 0, this.width, this.height])
            .style('font', '10px sans-serif');

        this.svg = svg;
        this.g = svg.append('g')
            .attr('transform', `translate(${this.width / 2},${this.height / 2})`);

        // Add center text
        this.centerText = this.g.append('text')
            .attr('class', 'sunburst-center-text')
            .attr('dy', '0.35em');
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

        // Create root node
        return {
            name: 'root',
            children: roots,
            is_directory: true
        };
    }

    renderSunburst() {
        if (!this.treeData) return;

        // Build hierarchy
        const hierarchyData = this.buildHierarchy(this.treeData);
        
        // Create d3 hierarchy
        const root = d3.hierarchy(hierarchyData)
            .sum(d => {
                // Leaf nodes: use metric value or 1
                if (!d.is_directory) {
                    return d.metrics ? d.metrics.value : 1;
                }
                return 0;
            })
            .sort((a, b) => b.value - a.value);

        // Calculate max value for color scale
        const maxValue = d3.max(root.descendants(), d => {
            if (d.data.metrics) {
                return d.data.metrics.value;
            }
            return 0;
        });

        // Create partition layout
        const partition = d3.partition()
            .size([2 * Math.PI, this.radius]);

        partition(root);

        // Arc generator
        const arc = d3.arc()
            .startAngle(d => d.x0)
            .endAngle(d => d.x1)
            .padAngle(d => Math.min((d.x1 - d.x0) / 2, 0.005))
            .padRadius(this.radius / 2)
            .innerRadius(d => d.y0)
            .outerRadius(d => d.y1 - 1);

        // Color scale
        const getColor = (d) => {
            if (!d.data.metrics || d.data.metrics.value === 0) {
                return '#2a2a2a';
            }
            
            const intensity = d.data.metrics.value / maxValue;
            
            if (intensity < 0.5) {
                const t = intensity * 2;
                return this.interpolateColor('#2a2a2a', '#4a9eff', t);
            } else {
                const t = (intensity - 0.5) * 2;
                return this.interpolateColor('#4a9eff', '#ff6b6b', t);
            }
        };

        // Clear previous
        this.g.selectAll('.sunburst-arc').remove();
        this.g.selectAll('.sunburst-text').remove();

        // Draw arcs
        const path = this.g.selectAll('.sunburst-arc')
            .data(root.descendants().filter(d => d.depth > 0))
            .join('path')
            .attr('class', 'sunburst-arc')
            .attr('d', arc)
            .attr('fill', d => getColor(d))
            .attr('fill-opacity', d => d.data.is_directory ? 0.7 : 1)
            .on('click', (event, d) => this.clicked(event, d))
            .on('mouseover', (event, d) => this.showTooltip(event, d))
            .on('mouseout', () => this.hideTooltip());

        // Add labels for larger segments
        const text = this.g.selectAll('.sunburst-text')
            .data(root.descendants().filter(d => {
                return d.depth > 0 && (d.x1 - d.x0) > 0.1; // Only show if arc is large enough
            }))
            .join('text')
            .attr('class', 'sunburst-text')
            .attr('transform', d => {
                const x = (d.x0 + d.x1) / 2 * 180 / Math.PI;
                const y = (d.y0 + d.y1) / 2;
                return `rotate(${x - 90}) translate(${y},0) rotate(${x < 180 ? 0 : 180})`;
            })
            .attr('dy', '0.35em')
            .text(d => d.data.name);

        // Update center text
        this.centerText.text(root.data.name);
    }

    clicked(event, p) {
        // Show details on single click
        this.showFileDetails(p.data);
        
        // Zoom on double-click
        if (event.detail === 2) {
            this.currentRoot = p;
            this.zoomTo(p);
        }
    }

    zoomTo(p) {
        // Store the current root
        this.currentRoot = p;
        
        // Recompute the partition layout with new root
        const root = d3.hierarchy(this.buildHierarchy(this.treeData))
            .sum(d => {
                if (!d.is_directory) {
                    return d.metrics ? d.metrics.value : 1;
                }
                return 0;
            })
            .sort((a, b) => b.value - a.value);

        // Calculate max value for color scale
        const maxValue = d3.max(root.descendants(), d => {
            if (d.data.metrics) {
                return d.data.metrics.value;
            }
            return 0;
        });

        // Find the node we want to zoom to in the new hierarchy
        const findNode = (node) => {
            if (node.data.id === p.data.id) return node;
            if (node.children) {
                for (const child of node.children) {
                    const found = findNode(child);
                    if (found) return found;
                }
            }
            return null;
        };

        const zoomNode = findNode(root) || root;

        // Create partition layout
        const partition = d3.partition()
            .size([2 * Math.PI, this.radius]);

        partition(root);

        // Arc generator
        const arc = d3.arc()
            .startAngle(d => d.x0)
            .endAngle(d => d.x1)
            .padAngle(d => Math.min((d.x1 - d.x0) / 2, 0.005))
            .padRadius(this.radius / 2)
            .innerRadius(d => d.y0)
            .outerRadius(d => d.y1 - 1);

        // Color scale
        const getColor = (d) => {
            if (!d.data.metrics || d.data.metrics.value === 0) {
                return '#2a2a2a';
            }
            
            const intensity = d.data.metrics.value / maxValue;
            
            if (intensity < 0.5) {
                const t = intensity * 2;
                return this.interpolateColor('#2a2a2a', '#4a9eff', t);
            } else {
                const t = (intensity - 0.5) * 2;
                return this.interpolateColor('#4a9eff', '#ff6b6b', t);
            }
        };

        // Update arcs with transition
        const path = this.g.selectAll('.sunburst-arc')
            .data(root.descendants().filter(d => d.depth > 0), d => d.data.id || d.data.name);

        // Transition arcs
        path.transition()
            .duration(750)
            .attrTween('d', d => () => {
                // Only show descendants of the zoom node
                if (!d.ancestors().includes(zoomNode)) {
                    return null;
                }
                
                // Adjust the arc to zoom into the selected node
                const xd = d3.interpolate(d.x0, d.x0);
                const yd = d3.interpolate(d.y0, Math.max(0, d.y0 - zoomNode.y0));
                const yr = d3.interpolate(d.y1, Math.max(0, d.y1 - zoomNode.y0));
                
                return arc({
                    x0: d.x0,
                    x1: d.x1,
                    y0: Math.max(0, d.y0 - zoomNode.y0),
                    y1: Math.max(0, d.y1 - zoomNode.y0)
                });
            });

        // Update center text
        this.centerText
            .transition()
            .duration(750)
            .text(p.data.name || 'root');

        // Update text labels
        const text = this.g.selectAll('.sunburst-text')
            .data(root.descendants().filter(d => {
                return d.depth > 0 && (d.x1 - d.x0) > 0.1;
            }), d => d.data.id || d.data.name);

        text.transition()
            .duration(750)
            .attr('opacity', d => {
                return d.ancestors().includes(zoomNode) ? 1 : 0;
            });
    }

    showTooltip(event, d) {
        // Update info panel
        this.showFileDetails(d.data);
    }

    hideTooltip() {
        // Optional: clear info panel or keep last selected
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
            <p><strong>Path:</strong> ${fileData.path || fileData.name}</p>
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
        
        if (fileData.is_directory) {
            html += '<p><em>Double-click to zoom in</em></p>';
        }
        
        infoContent.innerHTML = html;
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new RepoVis();
});
