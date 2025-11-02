const API_BASE = 'http://127.0.0.1:8000/api';

class TreemapVis {
    constructor() {
        this.treeData = null;
        this.currentMetric = 'commit_count';
        this.currentRoot = null;
        this.width = 0;
        this.height = 0;
        this.dateRange = null;
        this.selectedDateRange = null;
        
        this.init();
    }

    async init() {
        // Get date range from timeline first (more efficient)
        await this.getDateRangeFromTimeline();
        
        // Load data with full date range to get metrics
        if (this.dateRange) {
            await this.loadData(this.dateRange.min_date, this.dateRange.max_date);
        }
        
        // Setup timeline visualization
        await this.setupTimeline();
        
        // Setup visualization
        this.setupTreemap();
        
        // Setup controls
        this.setupControls();
        
        // Initial render with full data
        this.render();
    }

    async getDateRangeFromTimeline() {
        try {
            const response = await fetch(`${API_BASE}/timeline`);
            const data = await response.json();
            const timeline = data.timeline;
            
            if (timeline && timeline.length > 0) {
                this.dateRange = {
                    min_date: timeline[0].date,
                    max_date: timeline[timeline.length - 1].date
                };
                this.timelineData = timeline;
                console.log('Date range:', this.dateRange);
            }
        } catch (error) {
            console.error('Error getting date range:', error);
        }
    }

    async loadData(startDate = null, endDate = null) {
        try {
            let url = `${API_BASE}/tree`;
            if (startDate && endDate) {
                url += `?start_date=${startDate}&end_date=${endDate}`;
            }
            const response = await fetch(url);
            const data = await response.json();
            this.treeData = data.files; // API returns { files: [...] }
            this.dateRange = data.date_range;
            console.log('Data loaded:', this.treeData.length, 'files');
        } catch (error) {
            console.error('Error loading data:', error);
        }
    }

    async setupTimeline() {
        try {
            // Use cached timeline data if available
            const timeline = this.timelineData;
            
            if (!timeline || timeline.length === 0) return;
            
            // Set default date range
            this.selectedDateRange = {
                start: this.dateRange.min_date,
                end: this.dateRange.max_date
            };
            
            // Create timeline visualization
            const margin = {top: 10, right: 20, bottom: 30, left: 20};
            const width = document.getElementById('timeline').clientWidth - margin.left - margin.right;
            const height = 80 - margin.top - margin.bottom;
            
            const svg = d3.select('#timeline')
                .append('svg')
                .attr('width', width + margin.left + margin.right)
                .attr('height', height + margin.top + margin.bottom)
                .append('g')
                .attr('transform', `translate(${margin.left},${margin.top})`);
            
            // Parse dates
            timeline.forEach(d => {
                d.date = new Date(d.date);
            });
            
            // Scales
            const x = d3.scaleTime()
                .domain(d3.extent(timeline, d => d.date))
                .range([0, width]);
            
            const y = d3.scaleLinear()
                .domain([0, d3.max(timeline, d => d.count)])
                .range([height, 0]);
            
            // Area chart
            const area = d3.area()
                .x(d => x(d.date))
                .y0(height)
                .y1(d => y(d.count));
            
            svg.append('path')
                .datum(timeline)
                .attr('fill', '#58a6ff')
                .attr('opacity', 0.3)
                .attr('d', area);
            
            // X axis
            svg.append('g')
                .attr('transform', `translate(0,${height})`)
                .call(d3.axisBottom(x).ticks(5))
                .style('color', '#8b949e');
            
            // Brush for selection
            const brush = d3.brushX()
                .extent([[0, 0], [width, height]])
                .on('end', (event) => {
                    if (!event.selection) return;
                    const [x0, x1] = event.selection;
                    const startDate = x.invert(x0);
                    const endDate = x.invert(x1);
                    
                    this.selectedDateRange = {
                        start: startDate.toISOString().split('T')[0],
                        end: endDate.toISOString().split('T')[0]
                    };
                    
                    this.loadData(this.selectedDateRange.start, this.selectedDateRange.end)
                        .then(() => this.render());
                });
            
            svg.append('g')
                .attr('class', 'brush')
                .call(brush)
                .call(brush.move, [0, width]); // Select all by default
                
        } catch (error) {
            console.error('Error setting up timeline:', error);
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
        this.zoom = d3.zoom()
            .scaleExtent([0.1, Infinity])  // Allow unlimited zoom
            .on('zoom', (event) => {
                this.g.attr('transform', event.transform);
            });

        this.svg.call(this.zoom);
    }

    setupControls() {
        document.getElementById('reset-btn').addEventListener('click', () => {
            // Reset zoom/pan to identity transform
            this.svg.transition()
                .duration(750)
                .call(this.zoom.transform, d3.zoomIdentity);
            
            // Reset to root
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
            .padding(0)  // No padding between tiles
            .round(true)
            (displayRoot);

        // Calculate max value for color scale (only non-directories with metrics)
        const maxValue = d3.max(
            displayRoot.descendants().filter(d => !d.children && d.data.metrics), 
            d => d.data.metrics.value
        ) || 1;

        // Heatmap color scale (red = high, green = low)
        const color = d3.scaleSequential()
            .domain([0, maxValue])
            .interpolator(d3.interpolateRdYlGn)
            .unknown('#30363d');
        
        // Reverse the interpolator so red = high commits
        const colorReversed = d3.scaleSequential()
            .domain([maxValue, 0])  // Reversed domain
            .interpolator(d3.interpolateRdYlGn)
            .unknown('#30363d');

        // Clear previous
        this.g.selectAll('*').remove();

        console.log(`Rendering ${displayRoot.descendants().length} nodes, max value: ${maxValue}`);

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
                    // Files: full heatmap color
                    return d.data.metrics ? colorReversed(d.data.metrics.value) : '#30363d';
                } else {
                    // Directories: lighter version of heatmap based on aggregated value
                    if (d.value > 0) {
                        const baseColor = d3.color(colorReversed(d.value));  // Use total value
                        baseColor.opacity = 0.3;  // Make it semi-transparent
                        return baseColor.toString();
                    }
                    return '#21262d';
                }
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

        // Update breadcrumb
        this.updateBreadcrumb(displayRoot);
    }

    clicked(d) {
        if (d.children && d.value > 0) {
            // Zoom into this directory (only if it has a value)
            console.log(`Zooming into: ${d.data.name}, value: ${d.value}, children: ${d.children.length}`);
            this.currentRoot = d;
            this.render();
        } else if (d.children && d.value === 0) {
            // Directory with no metrics - show warning
            console.log(`Cannot zoom into ${d.data.name}: no data for selected time range`);
            alert(`No data available for "${d.data.name}" in the selected time range. Try selecting a different time period.`);
        } else {
            // Show file details
            console.log(`Showing details for: ${d.data.name}, is_directory: ${d.data.is_directory}, value: ${d.value}`);
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
