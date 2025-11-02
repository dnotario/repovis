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
        // Load initial data without date range to get the range first
        await this.loadMetadata();
        await this.loadContributors();
        
        // First load without dates to get the date range
        const response = await fetch(`${API_BASE}/tree`);
        const data = await response.json();
        this.dateRange = data.date_range;
        
        // Set form fields to full range
        document.getElementById('start-date').value = this.dateRange.min_date;
        document.getElementById('end-date').value = this.dateRange.max_date;
        this.selectedDateRange.start = this.dateRange.min_date;
        this.selectedDateRange.end = this.dateRange.max_date;
        
        // Now load with full date range to get metrics
        await this.loadTree(this.dateRange.min_date, this.dateRange.max_date);
        
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
        
        // Default to full date range if not specified
        if (!startDate || !endDate) {
            if (this.dateRange.min_date && this.dateRange.max_date) {
                startDate = this.dateRange.min_date;
                endDate = this.dateRange.max_date;
            }
        }
        
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

        // Add back button handler (keyboard shortcut)
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' || e.key === 'Escape') {
                e.preventDefault();
                this.goBack();
            }
        });
    }

    resetView() {
        // Re-render from scratch (returns to root)
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
            .sum(d => !d.is_directory ? (d.metrics ? d.metrics.value : 1) : 0)
            .sort((a, b) => b.value - a.value);

        // Store root
        this.root = root;

        // Create partition layout
        const partition = d3.partition()
            .size([2 * Math.PI, this.radius]);

        partition(root);

        // Calculate max value for color scale
        const maxValue = d3.max(root.descendants(), d => d.data.metrics ? d.data.metrics.value : 0);
        
        // Color function
        const color = d3.scaleSequential([0, maxValue], d3.interpolateCool);

        // Clear previous
        this.g.selectAll('*').remove();

        // Create path display element for current path
        const pathDisplay = d3.select('#current-path');
        if (pathDisplay.empty()) {
            d3.select('.visualization-container')
                .style('position', 'relative')
                .insert('div', ':first-child')
                .attr('id', 'current-path')
                .style('position', 'absolute')
                .style('top', '10px')
                .style('left', '10px')
                .style('background', 'rgba(0,0,0,0.8)')
                .style('padding', '10px 15px')
                .style('border-radius', '4px')
                .style('color', '#fff')
                .style('font-family', 'monospace')
                .style('font-size', '13px')
                .style('z-index', '1000')
                .text('/');
        }

        // Arc generator
        const arc = d3.arc()
            .startAngle(d => d.x0)
            .endAngle(d => d.x1)
            .padAngle(d => Math.min((d.x1 - d.x0) / 2, 0.005))
            .padRadius(this.radius / 2)
            .innerRadius(d => d.y0)
            .outerRadius(d => d.y1 - 1);

        const self = this;

        // Visibility helpers
        function arcVisible(d) {
            return d.y1 <= 3 && d.y0 >= 1 && d.x1 > d.x0;
        }

        function labelVisible(d) {
            return d.y1 <= 3 && d.y0 >= 1 && (d.y1 - d.y0) * (d.x1 - d.x0) > 0.03;
        }

        function labelTransform(d) {
            const x = (d.x0 + d.x1) / 2 * 180 / Math.PI;
            const y = (d.y0 + d.y1) / 2 * self.radius;
            return `rotate(${x - 90}) translate(${y},0) rotate(${x < 180 ? 0 : 180})`;
        }

        // Initialize current positions
        root.each(d => d.current = d);

        // Create arcs
        const path = this.g.append('g')
            .selectAll('path')
            .data(root.descendants())
            .join('path')
            .attr('fill', d => {
                if (d.depth === 0) return '#1a1a1a';
                return d.data.metrics ? color(d.data.metrics.value) : '#2a2a2a';
            })
            .attr('fill-opacity', d => arcVisible(d.current) ? (d.children ? 0.6 : 0.4) : 0)
            .attr('pointer-events', d => arcVisible(d.current) ? 'auto' : 'none')
            .attr('d', d => arc(d.current))
            .style('cursor', 'pointer')
            .on('click', clicked)
            .on('mouseover', (event, d) => self.showTooltip(event, d))
            .on('mouseout', () => self.hideTooltip());

        path.append('title')
            .text(d => `${d.ancestors().map(d => d.data.name).reverse().join('/')}\n${d.data.metrics ? d.data.metrics.value : 0}`);

        // Create labels
        const label = this.g.append('g')
            .attr('pointer-events', 'none')
            .attr('text-anchor', 'middle')
            .style('user-select', 'none')
            .selectAll('text')
            .data(root.descendants().slice(1))
            .join('text')
            .attr('dy', '0.35em')
            .attr('fill-opacity', d => +labelVisible(d.current))
            .attr('transform', d => labelTransform(d.current))
            .style('font-size', '10px')
            .style('fill', '#fff')
            .text(d => d.data.name);

        // Invisible center circle for clicking to zoom out
        const parent = this.g.append('circle')
            .datum(root)
            .attr('r', this.radius)
            .attr('fill', 'none')
            .attr('pointer-events', 'all')
            .on('click', clicked);

        // Update path display
        function updatePathDisplay(p) {
            const pathParts = [];
            let current = p;
            while (current) {
                pathParts.unshift(current.data.name || 'root');
                current = current.parent;
            }
            d3.select('#current-path').text(pathParts.join(' / '));
            
            // Show file details
            if (p.data && !p.data.is_directory) {
                self.showFileDetails(p.data);
            }
        }

        // Click handler for zoom
        function clicked(event, p) {
            parent.datum(p.parent || root);

            updatePathDisplay(p);

            root.each(d => d.target = {
                x0: Math.max(0, Math.min(1, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
                x1: Math.max(0, Math.min(1, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
                y0: Math.max(0, d.y0 - p.depth),
                y1: Math.max(0, d.y1 - p.depth)
            });

            const t = self.g.transition().duration(750);

            path.transition(t)
                .tween('data', d => {
                    const i = d3.interpolate(d.current, d.target);
                    return t => d.current = i(t);
                })
                .filter(function(d) {
                    return +this.getAttribute('fill-opacity') || arcVisible(d.target);
                })
                .attr('fill-opacity', d => arcVisible(d.target) ? (d.children ? 0.6 : 0.4) : 0)
                .attr('pointer-events', d => arcVisible(d.target) ? 'auto' : 'none')
                .attrTween('d', d => () => arc(d.current));

            label.filter(function(d) {
                    return +this.getAttribute('fill-opacity') || labelVisible(d.target);
                })
                .transition(t)
                .attr('fill-opacity', d => +labelVisible(d.target))
                .attrTween('transform', d => () => labelTransform(d.current));
        }

        // Initialize path display
        updatePathDisplay(root);
    }

    updateSelectionHighlight() {
        // Update stroke on all arcs to highlight the selected one
        this.g.selectAll('.sunburst-arc')
            .attr('stroke', d => {
                if (this.currentSelection && d.data.id === this.currentSelection.data.id) {
                    return '#4a9eff';
                }
                return '#1e1e1e';
            })
            .attr('stroke-width', d => {
                if (this.currentSelection && d.data.id === this.currentSelection.data.id) {
                    return 3;
                }
                return 1.5;
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
