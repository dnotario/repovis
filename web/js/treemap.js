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
            this.currentDirectory = null;
            this.currentRoot = null;
            this.render();
        });

        document.getElementById('metric-select').addEventListener('change', (e) => {
            this.currentMetric = e.target.value;
            this.render();
        });
    }

    buildHierarchy(files) {
        // Filter files if we're zoomed into a directory
        let filteredFiles = files;
        if (this.currentDirectory) {
            const dirPath = this.currentDirectory.endsWith('/') ? this.currentDirectory : this.currentDirectory + '/';
            
            // Find the directory node
            const dirNode = files.find(f => f.path === dirPath || f.path === this.currentDirectory);
            
            if (dirNode) {
                // Include the directory itself and all its descendants
                filteredFiles = files.filter(f => 
                    f.id === dirNode.id || 
                    (f.path && f.path.startsWith(dirPath))
                );
                console.log(`Filtered to ${filteredFiles.length} files under ${this.currentDirectory}`);
            }
        }
        
        // Create a map for quick lookup
        const fileMap = {};
        filteredFiles.forEach(f => {
            fileMap[f.id] = {
                ...f,
                children: []
            };
        });

        // Build hierarchy
        const roots = [];
        filteredFiles.forEach(f => {
            const node = fileMap[f.id];
            if (f.parent_id === null || !fileMap[f.parent_id]) {
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
                name: this.currentDirectory || 'root',
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

        // Store root for reference
        this.root = root;

        // Use the root as display root (filtering already done in buildHierarchy)
        const displayRoot = root;

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
        console.log(`Clicked: ${d.data.name}, has children: ${!!d.children}, value: ${d.value}`);
        
        if (d.children && d.value > 0) {
            // Zoom into this directory - filter to show only its contents
            console.log(`Zooming into directory: ${d.data.name}, path: ${d.data.path}`);
            this.currentDirectory = d.data.path || d.data.name;
            this.render();
        } else if (d.children && d.value === 0) {
            // Directory with no metrics
            alert(`No data available for "${d.data.name}" in the selected time range.`);
        } else {
            // File clicked - zoom to its parent directory
            console.log(`File clicked: ${d.data.name}`);
            if (d.parent && d.parent.data) {
                this.currentDirectory = d.parent.data.path || d.parent.data.name;
                this.render();
            }
            this.showInfo(d);
        }
    }

    updateBreadcrumb(node) {
        const breadcrumb = document.getElementById('breadcrumb');
        
        if (!this.currentDirectory) {
            breadcrumb.innerHTML = '<span style="color: #c9d1d9">root</span>';
            return;
        }
        
        // Split the path into parts
        const pathParts = this.currentDirectory.split('/').filter(p => p);
        const parts = ['root', ...pathParts];
        
        breadcrumb.innerHTML = parts.map((name, i) => {
            if (i === parts.length - 1) {
                // Current level - not clickable
                return `<span style="color: #c9d1d9">${name}</span>`;
            }
            // Clickable parent levels
            return `<span onclick="treemapVis.navigateToLevel(${i})">${name}</span>`;
        }).join(' / ');
    }

    navigateToLevel(level) {
        if (level === 0) {
            // Go to root
            this.currentDirectory = null;
            this.render();
            return;
        }
        
        // Build path up to this level
        const pathParts = this.currentDirectory.split('/').filter(p => p);
        const targetPath = pathParts.slice(0, level).join('/') + '/';
        
        this.currentDirectory = targetPath;
        this.render();
    }

    showInfo(d) {
        const info = document.getElementById('file-info');
        const data = d.data;

        // Compact display on 2-3 lines
        let parts = [];
        
        // Line 1: Name and type
        parts.push(`<strong>${data.name}</strong> (${data.is_directory ? 'Dir' : 'File'})`);
        
        // Line 2: Path
        if (data.path) {
            parts.push(`Path: ${data.path}`);
        }
        
        // Line 3: Metrics (inline)
        if (data.metrics || d.value) {
            let metrics = [];
            if (data.metrics) {
                if (data.metrics.value) metrics.push(`Commits: ${data.metrics.value}`);
                if (data.metrics.line_count) metrics.push(`Lines: ${data.metrics.line_count}`);
                if (data.metrics.unique_contributors) metrics.push(`Contributors: ${data.metrics.unique_contributors}`);
            } else if (d.value) {
                metrics.push(`Total: ${d.value.toFixed(0)}`);
            }
            if (metrics.length > 0) {
                parts.push(metrics.join(' • '));
            }
        }
        
        info.innerHTML = parts.join('<br>');
    }
}

// Initialize
let treemapVis;
window.addEventListener('DOMContentLoaded', () => {
    treemapVis = new TreemapVis();
});
