const API_BASE = '/api';

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
        this.contributors = null;
        this.selectedContributors = new Set(); // Store selected contributor IDs
        this.pendingMetricsRequest = null; // Track ongoing request
        this.nextMetricsRequest = null; // Track next request to make
        
        this.init();
    }

    async init() {
        // Get date range from timeline first (more efficient)
        await this.getDateRangeFromTimeline();
        
        // Load file structure (this never changes) - but don't use it for tree explorer
        await this.loadFileStructure();
        
        // Load contributors
        await this.loadContributors();
        
        // Load metrics for initial time range
        if (this.dateRange) {
            await this.loadMetrics(this.dateRange.min_date, this.dateRange.max_date);
        }
        
        // Setup timeline visualization
        await this.setupTimeline();
        
        // Setup visualization
        this.setupTreemap();
        
        // Setup tree explorer (loads its own data)
        this.setupTreeExplorer();
        
        // Setup contributors panel
        this.setupContributorsPanel();
        
        // Compute initial percentiles
        this.computePercentiles();
        
        // Initial render - builds structure once
        this.render();
    }
    
    computePercentiles() {
        // Compute percentiles once and cache them
        if (!this.root || !this.metricsData) return;
        
        // IMPORTANT: Update metrics in the hierarchy BEFORE computing percentiles
        this.root.each(node => {
            if (node.data) {
                const key = node.data.path || node.data.name;
                const currentMetrics = this.metricsData[key];
                node.data.metrics = currentMetrics;
            }
        });
        
        // Get all files with metrics (excluding 0s)
        const filesWithMetrics = this.root.descendants().filter(d => !d.children && d.data.metrics && d.data.metrics.value > 0);
        
        // Get all commit values and sort them
        const commitValues = filesWithMetrics.map(d => d.data.metrics.value).sort((a, b) => a - b);
        
        console.log(`Computing percentiles for ${commitValues.length} files with commits`);
        
        // Create a map from commit value to percentile
        this.percentileMap = new Map();
        
        for (let i = 0; i < commitValues.length; i++) {
            const value = commitValues[i];
            const percentile = (i + 1) / commitValues.length;
            
            // Store the highest percentile for this value (in case of duplicates)
            if (!this.percentileMap.has(value) || this.percentileMap.get(value) < percentile) {
                this.percentileMap.set(value, percentile);
            }
        }
        
        console.log(`Percentile map created with ${this.percentileMap.size} unique values`);
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

    async loadMetrics(startDate, endDate, contributorIds = null) {
        // Queue the request
        const requestParams = { startDate, endDate, contributorIds };
        
        // If there's already a pending request, store this as the next one
        if (this.pendingMetricsRequest) {
            this.nextMetricsRequest = requestParams;
            console.log('Request queued (pending request in progress)');
            return;
        }
        
        // Mark request as pending
        this.pendingMetricsRequest = requestParams;
        
        try {
            // Load only metrics for the time range
            let url = `${API_BASE}/tree?start_date=${startDate}&end_date=${endDate}`;
            
            console.log('loadMetrics called with:', {
                contributorIds,
                contributorsLength: this.contributors?.length,
                selectedCount: contributorIds?.length
            });
            
            // Add contributor filter if specified
            // Smart logic: use IN for small selections, NOT IN for "all minus a few"
            if (contributorIds !== null && this.contributors) {
                const totalContributors = this.contributors.length;
                const selectedCount = contributorIds.length;
                
                console.log(`Contributors: ${selectedCount} selected out of ${totalContributors} total`);
                
                if (selectedCount === 0) {
                    // No contributors selected - return empty results
                    // We still need to make the call but it will return no metrics
                    console.log('No contributors selected - using contributors=-1');
                    url += `&contributors=-1`; // Invalid ID ensures no results
                } else if (selectedCount <= totalContributors / 2) {
                    // Less than half selected - use IN
                    console.log(`Using IN with ${selectedCount} contributors`);
                    url += `&contributors=${contributorIds.join(',')}`;
                } else if (selectedCount < totalContributors) {
                    // More than half selected - use NOT IN
                    const unselectedIds = this.contributors
                        .map(c => c.id)
                        .filter(id => !contributorIds.includes(id));
                    console.log(`Using NOT IN with ${unselectedIds.length} excluded contributors`);
                    url += `&exclude_contributors=${unselectedIds.join(',')}`;
                } else {
                    console.log('All contributors selected - no filter');
                }
                // If all are selected, don't add any filter (most efficient)
            } else {
                console.log('contributorIds is null or contributors not loaded - no filter');
            }
            
            console.log('Fetching:', url);
            
            const response = await fetch(url);
            const data = await response.json();
            
            // Debug: Check how many files have metrics
            const filesWithMetrics = data.files.filter(f => f.metrics && f.metrics.value > 0);
            console.log(`API returned ${data.files.length} files, ${filesWithMetrics.length} have non-zero metrics`);
            
            // Create a map of metrics by file path
            this.metricsData = {};
            data.files.forEach(f => {
                const key = f.path || f.name;
                this.metricsData[key] = f.metrics;
            });
            
            console.log('Metrics loaded for', Object.keys(this.metricsData).length, 'files');
            
            // Compute percentiles once when metrics change
            this.computePercentiles();
            
            // Update colors only, not structure
            this.updateColors();
        } catch (error) {
            console.error('Error loading metrics:', error);
        } finally {
            // Mark request as complete
            this.pendingMetricsRequest = null;
            
            // If there's a queued request, process it now
            if (this.nextMetricsRequest) {
                const next = this.nextMetricsRequest;
                this.nextMetricsRequest = null;
                console.log('Processing queued request');
                this.loadMetrics(next.startDate, next.endDate, next.contributorIds);
            }
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
            const margin = {top: 20, right: 20, bottom: 20, left: 20};
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
            
            // Store references for updating
            this.timelineSvg = svg;
            this.timelineX = x;
            this.timelineHeight = height;
            
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
                    
                    // Update time range labels on timeline
                    this.updateTimelineRangeLabels();
                    
                    // Request update immediately - queuing handles max 1 outstanding request
                    const contributorIds = Array.from(this.selectedContributors);
                    this.loadMetrics(this.selectedDateRange.start, this.selectedDateRange.end, contributorIds);
                });
            
            const brushGroup = svg.append('g')
                .attr('class', 'brush')
                .call(brush)
                .call(brush.move, [0, width]); // Select all by default
            
            // Initial range labels
            this.updateTimelineRangeLabels();
                
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

    buildHierarchy(files) {
        // Always use full file structure - never filter
        const allFiles = this.fullTreeData || files;
        
        // Create a map for quick lookup and apply current metrics
        const fileMap = {};
        allFiles.forEach(f => {
            const key = f.path || f.name;
            const currentMetrics = this.metricsData ? this.metricsData[key] : f.metrics;
            
            fileMap[f.id] = {
                ...f,
                metrics: currentMetrics, // Use current time range metrics
                children: []
            };
        });

        // Build hierarchy - always full tree
        const roots = [];
        allFiles.forEach(f => {
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
                name: 'root',
                is_directory: true,
                children: roots
            };
        }
    }

    render() {
        if (!this.treeData) return;

        // Build hierarchy - always full structure
        const hierarchyData = this.buildHierarchy(this.treeData);
        
        // Create d3 hierarchy - size based on file count (always 1 per file)
        const root = d3.hierarchy(hierarchyData)
            .sum(d => {
                // Each file = 1, directories = 0 (sum of children)
                if (!d.is_directory) {
                    return 1;
                }
                return 0;
            })
            .sort((a, b) => b.value - a.value);

        // Store root for reference
        this.root = root;

        // Use the root as display root - always show full tree
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

        // Color scale: yellow for 0 commits, percentile-based for commits
        const getColor = (value) => {
            if (value === 0) return '#ffd700'; // Yellow for zero commits
            
            // Look up pre-computed percentile
            const percentile = this.percentileMap && this.percentileMap.has(value) ? this.percentileMap.get(value) : 0;
            
            // Map percentile (0-1) to color scale
            const scale = d3.scaleSequential()
                .domain([1, 0])  // Reversed: 1 = red (high percentile), 0 = green (low percentile)
                .interpolator(d3.interpolateRdYlGn);
            
            return scale(percentile);
        };

        // Clear previous
        this.g.selectAll('*').remove();
        
        // Clear highlight layer on render (it will be redrawn on hover)
        this.highlightLayer.selectAll('*').remove();

        console.log(`Rendering ${displayRoot.descendants().length} nodes`);

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
                    return d.data.metrics ? getColor(d.data.metrics.value) : '#30363d';
                } else {
                    // Directories: lighter version of heatmap based on aggregated value
                    if (d.value > 0) {
                        const baseColor = d3.color(getColor(d.value));  // Use total value
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
        console.log(`Clicked: ${d.data.name}, has children: ${!!d.children}`);
        
        // Just expand tree view and update breadcrumb - don't change treemap geometry
        const nodePath = d.data.path || d.data.name;
        this.expandAndScrollToNode(nodePath);
        
        // Update breadcrumb to show what was clicked
        const commitCount = (d.data.metrics && d.data.metrics.value) || 0;
        const additionalMetrics = d.data.metrics || null;
        this.setBreadcrumb(nodePath, !!d.children, commitCount, additionalMetrics);
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
            breadcrumb.innerHTML = '<span style="color: #58a6ff">root</span>';
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
        // At root, show root
        const path = null;
        const isDirectory = true;
        const commitCount = 0;
        const additionalMetrics = null;
        
        this.setBreadcrumb(path, isDirectory, commitCount, additionalMetrics);
    }

    navigateToLevel(level) {
        if (level === 0) {
            // Go to root - just update breadcrumb
            this.setBreadcrumb(null, true, 0, null);
            return;
        }
        
        // This function is called from breadcrumb clicks - just update the breadcrumb display
        // The treemap geometry stays the same
    }
    
    updateColors() {
        // Update only the fill colors of rectangles based on new metrics
        if (!this.root) return;
        
        // First, update the metrics in the hierarchy data
        this.root.each(node => {
            if (node.data) {
                const key = node.data.path || node.data.name;
                const currentMetrics = this.metricsData ? this.metricsData[key] : null;
                node.data.metrics = currentMetrics;
            }
        });
        
        console.log(`Updating colors with percentile map`);
        
        // Color scale: yellow for 0 commits, percentile-based for commits
        const getColor = (value) => {
            if (value === 0) return '#ffd700'; // Yellow for zero commits
            
            // Look up pre-computed percentile
            const percentile = this.percentileMap && this.percentileMap.has(value) ? this.percentileMap.get(value) : 0;
            
            // Map percentile (0-1) to color scale
            const scale = d3.scaleSequential()
                .domain([1, 0])  // Reversed: 1 = red (high percentile), 0 = green (low percentile)
                .interpolator(d3.interpolateRdYlGn);
            
            return scale(percentile);
        };
        
        // Update rectangle fills
        this.g.selectAll('rect')
            .transition()
            .duration(500)
            .attr('fill', function() {
                const node = d3.select(this.parentNode).datum();
                if (!node) return '#30363d';
                
                if (!node.children) {
                    // Files
                    return node.data.metrics ? getColor(node.data.metrics.value) : '#30363d';
                } else {
                    // Directories - calculate sum of children's metrics
                    let totalCommits = 0;
                    node.each(child => {
                        if (!child.children && child.data.metrics) {
                            totalCommits += child.data.metrics.value;
                        }
                    });
                    
                    if (totalCommits > 0) {
                        const baseColor = d3.color(getColor(totalCommits));
                        baseColor.opacity = 0.3;
                        return baseColor.toString();
                    }
                    return '#21262d';
                }
            });
        
        console.log(`Colors updated successfully`);
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
                    
                    // Double-click zooms to the directory
                    nameSpan.addEventListener('dblclick', (e) => {
                        e.stopPropagation();
                        this.zoomToNode(path);
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
    
    zoomToNode(path) {
        if (!this.root) return;
        
        // Normalize path
        const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path;
        
        // Find the node in the hierarchy
        let targetNode = null;
        this.root.each(node => {
            if (node.data) {
                const nodePath = node.data.path || node.data.name;
                const normalizedNodePath = nodePath && nodePath.endsWith('/') ? nodePath.slice(0, -1) : nodePath;
                
                if (normalizedNodePath === normalizedPath || nodePath === path) {
                    targetNode = node;
                }
            }
        });
        
        if (!targetNode) {
            console.log('zoomToNode: target not found', path);
            return;
        }
        
        console.log('Zooming to node:', targetNode.data.name, 'bounds:', targetNode.x0, targetNode.y0, targetNode.x1, targetNode.y1);
        
        // Clear highlight before zooming
        this.clearTreemapHighlight();
        
        // Calculate the transform to zoom to this node
        // The node bounds are in [0,1] space from the treemap layout
        const x0 = targetNode.x0;
        const y0 = targetNode.y0;
        const x1 = targetNode.x1;
        const y1 = targetNode.y1;
        
        // Calculate scale to fit the node in the viewport
        const nodeWidth = x1 - x0;
        const nodeHeight = y1 - y0;
        
        // Add some padding (90% of viewport)
        const scale = Math.min(0.9 / nodeWidth, 0.9 / nodeHeight);
        
        // Calculate translation to center the node
        const translateX = this.width / 2 - (x0 + nodeWidth / 2) * this.width * scale;
        const translateY = this.height / 2 - (y0 + nodeHeight / 2) * this.height * scale;
        
        // Create the transform
        const transform = d3.zoomIdentity
            .translate(translateX, translateY)
            .scale(scale);
        
        // Apply the transform with animation
        this.svg.transition()
            .duration(750)
            .call(this.zoom.transform, transform);
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
        
        // Just expand the tree view and update breadcrumb - don't change treemap
        this.expandAndScrollToNode(path);
        
        // Update breadcrumb
        const commitCount = this.metricsData && this.metricsData[path] ? this.metricsData[path].value : 0;
        const additionalMetrics = this.metricsData && this.metricsData[path] ? this.metricsData[path] : null;
        this.setBreadcrumb(path, file.is_directory, commitCount, additionalMetrics);
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
    
    async loadContributors() {
        try {
            const response = await fetch(`${API_BASE}/contributors`);
            const data = await response.json();
            this.contributors = data.contributors;
            
            // Initially select all contributors
            this.contributors.forEach(c => this.selectedContributors.add(c.id));
            
            console.log(`Loaded ${this.contributors.length} contributors, all selected`);
        } catch (error) {
            console.error('Error loading contributors:', error);
        }
    }
    
    setupContributorsPanel() {
        const search = document.getElementById('contributors-search');
        search.addEventListener('input', (e) => {
            this.filterContributors(e.target.value);
        });
        
        // Toggle buttons
        const toggleBtn = document.getElementById('toggle-contributors');
        const toggleBtnCollapsed = document.getElementById('toggle-contributors-collapsed');
        const panel = document.getElementById('contributors-panel');
        
        const togglePanel = () => {
            const isCollapsed = panel.classList.toggle('collapsed');
            toggleBtn.textContent = isCollapsed ? '◀' : '▶';
            toggleBtnCollapsed.style.display = isCollapsed ? 'block' : 'none';
        };
        
        toggleBtn.addEventListener('click', togglePanel);
        toggleBtnCollapsed.addEventListener('click', togglePanel);
        
        // Select All / Clear All buttons
        document.getElementById('select-all-contributors').addEventListener('click', () => {
            this.selectAllContributors();
        });
        
        document.getElementById('clear-all-contributors').addEventListener('click', () => {
            this.clearAllContributors();
        });
        
        // Render the list
        this.renderContributorsList();
    }
    
    renderContributorsList(filter = '') {
        if (!this.contributors) return;
        
        const list = document.getElementById('contributors-list');
        const filterLower = filter.toLowerCase();
        
        let html = '';
        this.contributors
            .filter(c => !filter || c.name.toLowerCase().includes(filterLower) || c.email.toLowerCase().includes(filterLower))
            .forEach(contributor => {
                const isChecked = this.selectedContributors.has(contributor.id);
                html += `
                    <div class="contributor-item" data-id="${contributor.id}">
                        <input type="checkbox" ${isChecked ? 'checked' : ''} data-id="${contributor.id}">
                        <span class="contributor-name" title="${contributor.email}">${contributor.name}</span>
                    </div>
                `;
            });
        
        list.innerHTML = html;
        
        // Add event listeners to checkboxes
        list.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                const contributorId = parseInt(e.target.getAttribute('data-id'));
                if (e.target.checked) {
                    this.selectedContributors.add(contributorId);
                } else {
                    this.selectedContributors.delete(contributorId);
                }
                
                // Update immediately without debounce
                this.updateMetricsFromContributors();
            });
        });
        
        // Also allow clicking on the item to toggle
        list.querySelectorAll('.contributor-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.tagName !== 'INPUT') {
                    const checkbox = item.querySelector('input[type="checkbox"]');
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
        });
    }
    
    filterContributors(filterText) {
        this.currentContributorFilter = filterText;
        this.renderContributorsList(filterText);
    }
    
    selectAllContributors() {
        this.contributors.forEach(c => this.selectedContributors.add(c.id));
        this.renderContributorsList(this.currentContributorFilter || '');
        this.updateMetricsFromContributors();
    }
    
    clearAllContributors() {
        this.selectedContributors.clear();
        this.renderContributorsList(this.currentContributorFilter || '');
        this.updateMetricsFromContributors();
    }
    
    updateMetricsFromContributors() {
        const contributorIds = Array.from(this.selectedContributors);
        this.loadMetrics(
            this.selectedDateRange.start, 
            this.selectedDateRange.end,
            contributorIds
        );
    }
    
    updateTimelineRangeLabels() {
        if (!this.timelineSvg || !this.selectedDateRange || !this.timelineX) return;
        
        // Remove existing labels
        this.timelineSvg.selectAll('.range-label').remove();
        
        // Parse dates
        const startDate = new Date(this.selectedDateRange.start);
        const endDate = new Date(this.selectedDateRange.end);
        
        // Get x positions
        const x0 = this.timelineX(startDate);
        const x1 = this.timelineX(endDate);
        
        // Add start date label
        this.timelineSvg.append('text')
            .attr('class', 'range-label')
            .attr('x', x0)
            .attr('y', -8)
            .attr('text-anchor', 'start')
            .attr('fill', '#58a6ff')
            .attr('font-size', '11px')
            .attr('font-family', 'monospace')
            .text(this.selectedDateRange.start);
        
        // Add end date label
        this.timelineSvg.append('text')
            .attr('class', 'range-label')
            .attr('x', x1)
            .attr('y', -8)
            .attr('text-anchor', 'end')
            .attr('fill', '#58a6ff')
            .attr('font-size', '11px')
            .attr('font-family', 'monospace')
            .text(this.selectedDateRange.end);
    }
}


// Initialize
let treemapVis;
window.addEventListener('DOMContentLoaded', () => {
    treemapVis = new TreemapVis();
});
