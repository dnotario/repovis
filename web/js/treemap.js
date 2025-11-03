const API_BASE = 'http://127.0.0.1:8000/api';

class TreemapVis {
    constructor() {
        this.treeData = null;
        this.fullTreeData = null; // Store full structure
        this.metricsData = null; // Store time-based metrics separately
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
        
        // Load file structure (this never changes) - but don't use it for tree explorer
        await this.loadFileStructure();
        
        // Load metrics for initial time range
        if (this.dateRange) {
            await this.loadMetrics(this.dateRange.min_date, this.dateRange.max_date);
        }
        
        // Setup timeline visualization
        await this.setupTimeline();
        
        // Setup visualization
        this.setupTreemap();
        
        // Setup controls
        this.setupControls();
        
        // Setup tree explorer (loads its own data)
        this.setupTreeExplorer();
        
        // Initial render - builds structure once
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

    async loadFileStructure() {
        try {
            // Load file structure without date filter - gets all files
            const response = await fetch(`${API_BASE}/tree`);
            const data = await response.json();
            this.fullTreeData = data.files;
            this.treeData = data.files;
            console.log('File structure loaded:', this.fullTreeData.length, 'files');
            
            // Debug: log a few sample files
            if (this.fullTreeData.length > 0) {
                const rootFiles = this.fullTreeData.filter(f => f.parent_id === null);
                console.log('Root files:', rootFiles.length, rootFiles.map(f => f.name));
            }
        } catch (error) {
            console.error('Error loading file structure:', error);
        }
    }

    async loadMetrics(startDate, endDate) {
        try {
            // Load only metrics for the time range
            const url = `${API_BASE}/tree?start_date=${startDate}&end_date=${endDate}`;
            const response = await fetch(url);
            const data = await response.json();
            
            // Create a map of metrics by file path
            this.metricsData = {};
            data.files.forEach(f => {
                const key = f.path || f.name;
                this.metricsData[key] = f.metrics;
            });
            
            console.log('Metrics loaded for', Object.keys(this.metricsData).length, 'files');
            
            // Update colors only, not structure
            this.updateColors();
        } catch (error) {
            console.error('Error loading metrics:', error);
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
            
            // Brush for selection with drag support
            const brush = d3.brushX()
                .extent([[0, 0], [width, height]])
                .on('brush end', (event) => {
                    if (!event.selection) return;
                    const [x0, x1] = event.selection;
                    const startDate = x.invert(x0);
                    const endDate = x.invert(x1);
                    
                    this.selectedDateRange = {
                        start: startDate.toISOString().split('T')[0],
                        end: endDate.toISOString().split('T')[0]
                    };
                    
                    // Only reload on brush end to avoid too many updates
                    if (event.type === 'end') {
                        this.loadMetrics(this.selectedDateRange.start, this.selectedDateRange.end);
                    }
                });
            
            const brushGroup = svg.append('g')
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
        
        // Add a highlight layer on top that also transforms with zoom
        this.highlightLayer = this.svg.append('g');

        // Initialize scales for proper zoom behavior (prevents pixel rounding issues)
        this.xScale = d3.scaleLinear().rangeRound([0, this.width]);
        this.yScale = d3.scaleLinear().rangeRound([0, this.height]);

        // Add zoom and pan behavior using scale-based zooming
        this.zoom = d3.zoom()
            .scaleExtent([0.1, 1000])  // Allow zoom out to 10% and in to 1000x
            .on('zoom', (event) => {
                // Update this for re-rendering on zoom
                this.currentTransform = event.transform;
                this.render();
            });

        this.svg.call(this.zoom);
        
        // Initialize transform
        this.currentTransform = d3.zoomIdentity;
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
        // Always use full file structure
        const allFiles = this.fullTreeData || files;
        
        // Filter files if we're zoomed into a directory
        let filteredFiles = allFiles;
        if (this.currentDirectory) {
            const dirPath = this.currentDirectory.endsWith('/') ? this.currentDirectory : this.currentDirectory + '/';
            
            // Find the directory node
            const dirNode = allFiles.find(f => f.path === dirPath || f.path === this.currentDirectory);
            
            if (dirNode) {
                // Include the directory itself and all its descendants
                filteredFiles = allFiles.filter(f => 
                    f.id === dirNode.id || 
                    (f.path && f.path.startsWith(dirPath))
                );
                console.log(`Filtered to ${filteredFiles.length} files under ${this.currentDirectory}`);
            }
        }
        
        // Create a map for quick lookup and apply current metrics
        const fileMap = {};
        filteredFiles.forEach(f => {
            const key = f.path || f.name;
            const currentMetrics = this.metricsData ? this.metricsData[key] : f.metrics;
            
            fileMap[f.id] = {
                ...f,
                metrics: currentMetrics, // Use current time range metrics
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

        // Create treemap layout (use unit square [0,1] for better zoom behavior)
        d3.treemap()
            .size([1, 1])
            .padding(0)
            .round(false)  // Don't round in unit space
            (displayRoot);

        // Update scales based on current zoom/pan transform
        const t = this.currentTransform || d3.zoomIdentity;
        this.xScale.domain([t.invertX(0) / this.width, t.invertX(this.width) / this.width]);
        this.yScale.domain([t.invertY(0) / this.height, t.invertY(this.height) / this.height]);

        // Calculate max value for color scale (only non-directories with metrics)
        const maxValue = d3.max(
            displayRoot.descendants().filter(d => !d.children && d.data.metrics), 
            d => d.data.metrics.value
        ) || 1;

        // Reverse the interpolator so red = high commits
        const colorReversed = d3.scaleSequential()
            .domain([maxValue, 0])  // Reversed domain
            .interpolator(d3.interpolateRdYlGn)
            .unknown('#30363d');

        // Clear previous
        this.g.selectAll('*').remove();

        console.log(`Rendering ${displayRoot.descendants().length} nodes, max value: ${maxValue}`);

        // Filter to only visible nodes (within viewport)
        const visibleNodes = displayRoot.descendants().filter(d => {
            const x = this.xScale(d.x0);
            const y = this.yScale(d.y0);
            const w = this.xScale(d.x1) - this.xScale(d.x0);
            const h = this.yScale(d.y1) - this.yScale(d.y0);
            
            // Only render if tile has visible size (> 1px) and is in viewport
            return w >= 1 && h >= 1 && 
                   x < this.width && x + w > 0 && 
                   y < this.height && y + h > 0;
        });

        console.log(`Visible nodes: ${visibleNodes.length} of ${displayRoot.descendants().length}`);

        // Create cells using scale-based positioning
        const cell = this.g.selectAll('g')
            .data(visibleNodes)
            .join('g')
            .attr('class', 'node');

        // Add rectangles with scale-based dimensions
        cell.append('rect')
            .attr('x', d => this.xScale(d.x0))
            .attr('y', d => this.yScale(d.y0))
            .attr('width', d => Math.max(0, this.xScale(d.x1) - this.xScale(d.x0)))
            .attr('height', d => Math.max(0, this.yScale(d.y1) - this.yScale(d.y0)))
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
            .attr('stroke-width', 0.5)
            .on('click', (event, d) => {
                event.stopPropagation();
                this.clicked(d);
            })
            .on('mouseover', (event, d) => {
                this.highlightTreemapNode(d);
                this.updateBreadcrumbOnHover(d);
            })
            .on('mouseout', (event, d) => {
                this.clearTreemapHighlight();
                this.restoreBreadcrumb();
            });

        // Update breadcrumb
        this.updateBreadcrumb(displayRoot);
    }

    clicked(d) {
        console.log(`Clicked: ${d.data.name}, has children: ${!!d.children}, value: ${d.value}`);
        
        if (d.children && d.value > 0) {
            // Zoom into this directory - filter view, keep structure
            console.log(`Zooming into directory: ${d.data.name}, path: ${d.data.path}`);
            this.currentDirectory = d.data.path || d.data.name;
            this.render(); // Rebuild to show only this subtree
            
            // After render completes, expand file tree to the clicked node
            const nodePath = d.data.path || d.data.name;
            this.expandAndScrollToNode(nodePath);
        } else if (d.children && d.value === 0) {
            // Directory with no metrics
            alert(`No data available for "${d.data.name}" in the selected time range.`);
        } else {
            // File clicked - zoom to its parent directory
            console.log(`File clicked: ${d.data.name}`);
            if (d.parent && d.parent.data) {
                this.currentDirectory = d.parent.data.path || d.parent.data.name;
                this.render(); // Rebuild to show parent's subtree
                
                // Expand to the file's location
                const nodePath = d.data.path || d.data.name;
                this.expandAndScrollToNode(nodePath);
            }
            this.showInfo(d);
        }
    }
    
    resetZoomAndRender() {
        // Reset zoom/pan to identity transform
        this.currentTransform = d3.zoomIdentity;
        this.svg.transition()
            .duration(300)
            .call(this.zoom.transform, d3.zoomIdentity);
    }

    // Shared breadcrumb update function - used by both treemap and file explorer
    setBreadcrumb(path, isDirectory, commitCount = 0, additionalMetrics = null) {
        const breadcrumb = document.getElementById('breadcrumb');
        const info = document.getElementById('file-info');
        
        // Normalize path
        const normalizedPath = path ? (path.endsWith('/') ? path.slice(0, -1) : path) : null;
        
        if (!normalizedPath) {
            // Root level
            breadcrumb.innerHTML = '<span style="color: #8b949e">root</span> / <span style="color: #58a6ff">root (Dir)</span>';
            info.innerHTML = '';
            return;
        }
        
        // Split the path into parts
        const pathParts = normalizedPath.split('/').filter(p => p);
        const parts = ['root', ...pathParts];
        
        const typeLabel = isDirectory ? 'Dir' : 'File';
        const commitText = commitCount > 0 ? ` - ${commitCount} commits` : '';
        
        // Build breadcrumb: gray for root path, blue for current item
        const breadcrumbParts = parts.map((name, i) => {
            if (i === 0) {
                // Root - always gray and clickable
                return `<span style="color: #8b949e" onclick="treemapVis.navigateToLevel(0)">${name}</span>`;
            } else if (i === parts.length - 1) {
                // Current item - blue and not clickable
                return `<span style="color: #58a6ff">${name} (${typeLabel})${commitText}</span>`;
            } else {
                // Intermediate path - gray and clickable
                return `<span style="color: #8b949e" onclick="treemapVis.navigateToLevel(${i})">${name}</span>`;
            }
        });
        
        breadcrumb.innerHTML = breadcrumbParts.join(' / ');
        
        // Show additional metrics in file-info if available
        if (additionalMetrics) {
            const metrics = [];
            if (additionalMetrics.line_count) metrics.push(`Lines: ${additionalMetrics.line_count}`);
            if (additionalMetrics.unique_contributors) metrics.push(`Contributors: ${additionalMetrics.unique_contributors}`);
            info.innerHTML = metrics.join(' • ');
        } else {
            info.innerHTML = '';
        }
    }

    updateBreadcrumb(node) {
        const path = this.currentDirectory;
        const isDirectory = node && node.children ? true : false;
        const commitCount = (node && node.data && node.data.metrics && node.data.metrics.value) || 0;
        const additionalMetrics = (node && node.data && node.data.metrics) || null;
        
        this.setBreadcrumb(path, isDirectory, commitCount, additionalMetrics);
    }

    navigateToLevel(level) {
        if (level === 0) {
            // Go to root
            this.currentDirectory = null;
            this.render(); // Don't reset zoom
            return;
        }
        
        // Build path up to this level
        const pathParts = this.currentDirectory.split('/').filter(p => p);
        const targetPath = pathParts.slice(0, level).join('/') + '/';
        
        this.currentDirectory = targetPath;
        this.render(); // Don't reset zoom
    }
    
    updateColors() {
        // Update only the fill colors of rectangles based on new metrics
        if (!this.root) return;
        
        const displayRoot = this.currentRoot || this.root;
        
        // Recalculate max value with new metrics
        const maxValue = d3.max(
            displayRoot.descendants().filter(d => !d.children && d.data.metrics), 
            d => d.data.metrics.value
        ) || 1;
        
        const colorReversed = d3.scaleSequential()
            .domain([maxValue, 0])
            .interpolator(d3.interpolateRdYlGn)
            .unknown('#30363d');
        
        // Update rectangle fills
        this.g.selectAll('rect')
            .transition()
            .duration(500)
            .attr('fill', function() {
                const node = d3.select(this.parentNode).datum();
                if (!node) return '#30363d';
                
                if (!node.children) {
                    // Files
                    return node.data.metrics ? colorReversed(node.data.metrics.value) : '#30363d';
                } else {
                    // Directories
                    if (node.value > 0) {
                        const baseColor = d3.color(colorReversed(node.value));
                        baseColor.opacity = 0.3;
                        return baseColor.toString();
                    }
                    return '#21262d';
                }
            });
        
        console.log(`Colors updated, max value: ${maxValue}`);
    }

    showInfo(d) {
        // Info is now handled in updateBreadcrumb
        // Just update the breadcrumb when a node is clicked
        this.updateBreadcrumb(d);
    }
    
    setupTreeExplorer() {
        const search = document.getElementById('search-input');
        search.addEventListener('input', (e) => {
            this.filterTreeView(e.target.value);
        });
        
        // Toggle buttons (one inside explorer, one outside when collapsed)
        const toggleBtn = document.getElementById('toggle-explorer');
        const toggleBtnCollapsed = document.getElementById('toggle-explorer-collapsed');
        const explorer = document.getElementById('tree-explorer');
        
        const toggleExplorer = () => {
            const isCollapsed = explorer.classList.toggle('collapsed');
            toggleBtn.textContent = isCollapsed ? '▶' : '◀';
            toggleBtnCollapsed.style.display = isCollapsed ? 'block' : 'none';
        };
        
        toggleBtn.addEventListener('click', toggleExplorer);
        toggleBtnCollapsed.addEventListener('click', toggleExplorer);
        
        // Load tree data from API
        this.loadTreeExplorerData();
    }
    
    async loadTreeExplorerData() {
        try {
            const response = await fetch(`${API_BASE}/tree`);
            const data = await response.json();
            this.explorerTreeData = data.files;
            console.log('Tree explorer loaded:', this.explorerTreeData.length, 'files');
            this.renderTreeView();
        } catch (error) {
            console.error('Error loading tree explorer data:', error);
        }
    }
    
    renderTreeView(filter = '') {
        if (!this.explorerTreeData) {
            console.log('renderTreeView: No explorerTreeData');
            return;
        }
        
        console.log(`renderTreeView: ${this.explorerTreeData.length} files, filter="${filter}"`);
        
        const treeView = document.getElementById('tree-view');
        const hierarchy = this.buildHierarchyForTree(this.explorerTreeData);
        
        console.log('Hierarchy:', hierarchy ? {name: hierarchy.name, childCount: hierarchy.children ? hierarchy.children.length : 0} : 'null');
        
        // Track expanded state
        if (!this.expandedNodes) {
            this.expandedNodes = new Set();
        }
        
        let html = '';
        let nodeCount = 0;
        
        const renderNode = (node, depth = 0) => {
            if (!node) return;
            
            const isDir = node.is_directory;
            const hasChildren = node.children && node.children.length > 0;
            const nodePath = node.path || node.name;
            const isExpanded = this.expandedNodes.has(nodePath);
            
            const matchesFilter = !filter || node.name.toLowerCase().includes(filter.toLowerCase());
            
            if (matchesFilter || (hasChildren && !filter)) {
                // Render this node
                let icon = '';
                if (hasChildren) {
                    // Directory with chevron
                    icon = `<span class="tree-chevron">${isExpanded ? '▼' : '▶'}</span>📁`;
                } else {
                    // File
                    icon = '<span class="tree-spacer"></span>📄';
                }
                
                const className = isDir ? 'directory' : 'file';
                html += `<div class="tree-node ${className}" data-path="${nodePath}" data-has-children="${hasChildren}" style="padding-left: ${depth * 16 + 8}px">
                    ${icon}<span class="tree-name">${node.name}</span>
                </div>`;
                nodeCount++;
                
                // Render children only if expanded (or filtering)
                if (hasChildren && (isExpanded || filter)) {
                    node.children
                        .sort((a, b) => {
                            // Directories first, then alphabetical
                            if (a.is_directory && !b.is_directory) return -1;
                            if (!a.is_directory && b.is_directory) return 1;
                            return a.name.localeCompare(b.name);
                        })
                        .forEach(child => renderNode(child, depth + 1));
                }
            }
        };
        
        if (hierarchy) {
            // Render children of synthetic root
            if (hierarchy.children) {
                hierarchy.children
                    .sort((a, b) => {
                        if (a.is_directory && !b.is_directory) return -1;
                        if (!a.is_directory && b.is_directory) return 1;
                        return a.name.localeCompare(b.name);
                    })
                    .forEach(child => renderNode(child, 0));
            }
        }
        
        console.log(`Rendered ${nodeCount} tree nodes`);
        treeView.innerHTML = html;
        
        // Add click and hover handlers
        treeView.querySelectorAll('.tree-node').forEach(node => {
            const hasChildren = node.getAttribute('data-has-children') === 'true';
            const path = node.getAttribute('data-path');
            
            // Hover handlers - highlight in treemap and update breadcrumb
            node.addEventListener('mouseenter', () => {
                this.highlightNodeInTreemap(path);
                this.updateBreadcrumbFromFileExplorer(path);
            });
            
            node.addEventListener('mouseleave', () => {
                this.clearTreemapHighlight();
                this.restoreBreadcrumb();
            });
            
            if (hasChildren) {
                // Click on chevron toggles expand/collapse, click on name navigates
                const chevron = node.querySelector('.tree-chevron');
                const nameSpan = node.querySelector('.tree-name');
                
                if (chevron) {
                    chevron.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (this.expandedNodes.has(path)) {
                            this.expandedNodes.delete(path);
                        } else {
                            this.expandedNodes.add(path);
                        }
                        
                        // Re-render tree with updated expansion state
                        this.renderTreeView(this.currentFilter || '');
                    });
                }
                
                // Click on directory name navigates to it in the treemap
                if (nameSpan) {
                    nameSpan.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.navigateToPath(path);
                    });
                }
            } else {
                // Click on file navigates to it
                node.addEventListener('click', () => {
                    this.navigateToPath(path);
                });
            }
        });
    }
    
    highlightNodeInTreemap(path) {
        if (!this.highlightLayer) return;
        
        // Remove previous highlight
        this.highlightLayer.selectAll('.hover-highlight').remove();
        
        // Normalize path (remove trailing slash for comparison)
        const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path;
        
        // Find the matching node and draw a white border around it
        this.g.selectAll('rect')
            .each((d) => {
                if (d && d.data) {
                    const nodePath = d.data.path;
                    const normalizedNodePath = nodePath && nodePath.endsWith('/') ? nodePath.slice(0, -1) : nodePath;
                    
                    if (normalizedNodePath === normalizedPath) {
                        // Get the rect dimensions using scales
                        const x = this.xScale(d.x0);
                        const y = this.yScale(d.y0);
                        const width = this.xScale(d.x1) - this.xScale(d.x0);
                        const height = this.yScale(d.y1) - this.yScale(d.y0);
                        
                        // Draw white border on the highlight layer (on top of everything)
                        this.highlightLayer
                            .append('rect')
                            .attr('class', 'hover-highlight')
                            .attr('x', x)
                            .attr('y', y)
                            .attr('width', width)
                            .attr('height', height)
                            .attr('fill', 'none')
                            .attr('stroke', 'white')
                            .attr('stroke-width', 4)
                            .attr('pointer-events', 'none');
                    }
                }
            });
    }
    
    clearTreemapHighlight() {
        if (!this.highlightLayer) return;
        
        // Remove the highlight rectangle
        this.highlightLayer.selectAll('.hover-highlight').remove();
    }
    
    highlightTreemapNode(d) {
        if (!this.highlightLayer) return;
        
        // Remove previous highlight
        this.highlightLayer.selectAll('.hover-highlight').remove();
        
        // Get the rect dimensions using scales
        const x = this.xScale(d.x0);
        const y = this.yScale(d.y0);
        const width = this.xScale(d.x1) - this.xScale(d.x0);
        const height = this.yScale(d.y1) - this.yScale(d.y0);
        
        // Draw white border on the highlight layer (on top of everything)
        this.highlightLayer
            .append('rect')
            .attr('class', 'hover-highlight')
            .attr('x', x)
            .attr('y', y)
            .attr('width', width)
            .attr('height', height)
            .attr('fill', 'none')
            .attr('stroke', 'white')
            .attr('stroke-width', 4)
            .attr('pointer-events', 'none');
    }
    
    // Update breadcrumb when hovering over treemap node
    updateBreadcrumbOnHover(d) {
        // Store the original breadcrumb for restoration
        if (!this.originalBreadcrumb) {
            this.originalBreadcrumb = document.getElementById('breadcrumb').innerHTML;
            this.originalFileInfo = document.getElementById('file-info').innerHTML;
        }
        
        const path = d.data.path || d.data.name;
        const isDirectory = !!d.children;
        const commitCount = (d.data.metrics && d.data.metrics.value) || d.value || 0;
        const additionalMetrics = d.data.metrics || null;
        
        this.setBreadcrumb(path, isDirectory, commitCount, additionalMetrics);
    }
    
    restoreBreadcrumb() {
        if (this.originalBreadcrumb) {
            document.getElementById('breadcrumb').innerHTML = this.originalBreadcrumb;
            document.getElementById('file-info').innerHTML = this.originalFileInfo || '';
            this.originalBreadcrumb = null;
            this.originalFileInfo = null;
        }
    }
    
    // Update breadcrumb when hovering over file explorer node
    updateBreadcrumbFromFileExplorer(path) {
        // Store the original breadcrumb for restoration
        if (!this.originalBreadcrumb) {
            this.originalBreadcrumb = document.getElementById('breadcrumb').innerHTML;
            this.originalFileInfo = document.getElementById('file-info').innerHTML;
        }
        
        if (!this.explorerTreeData) return;
        
        // Normalize path
        const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path;
        
        // Find the node data from explorerTreeData
        const node = this.explorerTreeData.find(f => {
            const fp = f.path.endsWith('/') ? f.path.slice(0, -1) : f.path;
            return fp === normalizedPath;
        });
        
        if (!node) return;
        
        // Get commit count from metricsData
        let commitCount = 0;
        let additionalMetrics = null;
        if (this.metricsData) {
            const metrics = this.metricsData[normalizedPath] || this.metricsData[path];
            if (metrics) {
                commitCount = metrics.value || 0;
                additionalMetrics = metrics;
            }
        }
        
        this.setBreadcrumb(path, node.is_directory, commitCount, additionalMetrics);
    }
    
    buildHierarchyForTree(files) {
        const fileMap = {};
        files.forEach(f => {
            fileMap[f.id] = { ...f, children: [] };
        });
        
        files.forEach(f => {
            const node = fileMap[f.id];
            if (f.parent_id && fileMap[f.parent_id]) {
                fileMap[f.parent_id].children.push(node);
            }
        });
        
        const roots = files.filter(f => f.parent_id === null);
        console.log(`buildHierarchyForTree: ${roots.length} roots found`);
        
        // If multiple roots, create a synthetic root
        if (roots.length === 0) {
            return { name: 'root', children: [], is_directory: true };
        } else if (roots.length === 1) {
            return fileMap[roots[0].id];
        } else {
            // Multiple roots - create synthetic parent
            const syntheticRoot = {
                name: 'root',
                is_directory: true,
                children: roots.map(r => fileMap[r.id])
            };
            console.log(`Created synthetic root with ${syntheticRoot.children.length} children`);
            return syntheticRoot;
        }
    }
    
    filterTreeView(filterText) {
        this.currentFilter = filterText;
        this.renderTreeView(filterText);
    }
    
    navigateToPath(path) {
        const file = this.treeData.find(f => f.path === path || f.name === path);
        if (!file) return;
        
        if (file.is_directory) {
            this.currentDirectory = path;
        } else {
            // Navigate to parent
            const parent = this.treeData.find(f => f.id === file.parent_id);
            if (parent) {
                this.currentDirectory = parent.path || parent.name;
            }
        }
        
        this.render();
    }
    
    expandAndScrollToNode(targetPath) {
        if (!this.explorerTreeData) {
            console.log('expandAndScrollToNode: explorerTreeData not loaded yet');
            return;
        }
        
        console.log('expandAndScrollToNode called with:', targetPath);
        console.log('explorerTreeData has', this.explorerTreeData.length, 'items');
        
        // Normalize path - remove trailing slash
        const normalizedPath = targetPath.endsWith('/') ? targetPath.slice(0, -1) : targetPath;
        
        // Find the target node
        const targetNode = this.explorerTreeData.find(f => {
            const fp = (f.path || '').endsWith('/') ? f.path.slice(0, -1) : f.path;
            return fp === normalizedPath || f.path === targetPath;
        });
        
        if (!targetNode) {
            console.log('expandAndScrollToNode: target not found', targetPath);
            console.log('Sample paths:', this.explorerTreeData.slice(0, 5).map(f => f.path));
            return;
        }
        
        console.log('Found target node:', targetNode);
        
        // Build path from root to target by traversing parents
        const pathsToExpand = [];
        let currentId = targetNode.parent_id;
        
        while (currentId) {
            const parentNode = this.explorerTreeData.find(f => f.id === currentId);
            if (!parentNode) break;
            
            // Add the parent's path (as it appears in tree view)
            pathsToExpand.unshift(parentNode.path);
            currentId = parentNode.parent_id;
        }
        
        console.log('Paths to expand:', pathsToExpand);
        
        // Clear existing expansions and add all parent paths
        pathsToExpand.forEach(path => {
            this.expandedNodes.add(path);
        });
        
        // Re-render the tree view with expanded parents
        this.renderTreeView(this.currentFilter || '');
        
        // Scroll to the target node after a short delay to allow rendering
        setTimeout(() => {
            const treeView = document.getElementById('tree-view');
            
            // Try to find the element by both paths
            let targetElement = treeView.querySelector(`[data-path="${targetPath}"]`);
            if (!targetElement) {
                targetElement = treeView.querySelector(`[data-path="${normalizedPath}"]`);
            }
            
            console.log('Scrolling to element:', targetElement, 'for path:', targetPath);
            
            if (targetElement) {
                targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // Briefly highlight the target
                targetElement.style.backgroundColor = '#1f6feb';
                setTimeout(() => {
                    targetElement.style.backgroundColor = '';
                }, 1000);
            } else {
                console.log('Could not find tree element for path:', targetPath);
            }
        }, 100);
    }
}


// Initialize
let treemapVis;
window.addEventListener('DOMContentLoaded', () => {
    treemapVis = new TreemapVis();
});
