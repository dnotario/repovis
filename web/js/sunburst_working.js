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
        // Clear selection history and current selection
        this.selectionHistory = [];
        this.currentSelection = null;
        
        // Zoom back to root
        if (this.root) {
            this.zoomToNode(this.root);
        }
        
        // Update selection highlight
        this.updateSelectionHighlight();
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
        
        // Create a group for zoom/pan
        this.zoomGroup = svg.append('g');
        
        this.g = this.zoomGroup.append('g')
            .attr('transform', `translate(${this.width / 2},${this.height / 2})`);

        // Add center text
        this.centerText = this.g.append('text')
            .attr('class', 'sunburst-center-text')
            .attr('dy', '0.35em');

        // Add zoom behavior - no limits
        const zoom = d3.zoom()
            .scaleExtent([0.01, Infinity])
            .on('zoom', (event) => {
                this.zoomGroup.attr('transform', event.transform);
                
                // Debounce label updates to avoid flashing
                if (this.labelUpdateTimeout) {
                    clearTimeout(this.labelUpdateTimeout);
                }
                this.labelUpdateTimeout = setTimeout(() => {
                    this.updateLabelVisibility(event.transform.k);
                }, 50);
            })
            .on('end', (event) => {
                // Always update at end of zoom/pan
                if (this.labelUpdateTimeout) {
                    clearTimeout(this.labelUpdateTimeout);
                }
                this.updateLabelVisibility(event.transform.k);
            });

        svg.call(zoom);
        
        // Store zoom behavior for reset
        this.zoom = zoom;
        this.currentRotation = 0;
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

        // Store root for later use
        this.root = root;

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

        // Draw arcs (including root at depth 0)
        const path = this.g.selectAll('.sunburst-arc')
            .data(root.descendants())
            .join('path')
            .attr('class', 'sunburst-arc')
            .attr('d', arc)
            .attr('fill', d => {
                if (d.depth === 0) return '#1a1a1a'; // Root is dark
                return getColor(d);
            })
            .attr('fill-opacity', d => {
                if (d.depth === 0) return 0.3;
                return d.data.is_directory ? 0.7 : 1;
            })
            .attr('stroke', d => {
                // Highlight selected node
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
            })
            .on('click', (event, d) => this.clicked(event, d))
            .on('mouseover', (event, d) => this.showTooltip(event, d))
            .on('mouseout', () => this.hideTooltip());

        // Add labels - initially all rendered but with visibility controlled
        const text = this.g.selectAll('.sunburst-text')
            .data(root.descendants().filter(d => d.depth > 0))
            .join('text')
            .attr('class', 'sunburst-text')
            .attr('transform', d => {
                const angle = (d.x0 + d.x1) / 2; // In radians
                const angleDeg = angle * 180 / Math.PI; // Convert to degrees
                const radius = (d.y0 + d.y1) / 2;
                
                // Rotate to the angle position
                const rotation = angleDeg - 90;
                
                // Check if text would be upside down (on left half of circle)
                // Text is upside down if the rotation puts it between 90 and 270 degrees
                const finalRotation = rotation % 360;
                const needsFlip = finalRotation > 90 && finalRotation < 270;
                
                if (needsFlip) {
                    // Flip the text 180 degrees so it reads from outside-in
                    return `rotate(${rotation}) translate(${radius},0) rotate(180)`;
                } else {
                    // Normal orientation - reads from inside-out
                    return `rotate(${rotation}) translate(${radius},0)`;
                }
            })
            .attr('dy', '0.35em')
            .attr('text-anchor', 'middle')
            .text(d => d.data.name);

        // Update center text
        this.centerText.text(root.data.name);

        // Set initial label visibility - this will set font sizes and display
        this.updateLabelVisibility(1);
    }

    updateLabelVisibility(zoomLevel) {
        // Simple approach: show text only if arc is large enough
        this.g.selectAll('.sunburst-text')
            .each(function(d) {
                if (!d || !d.data.name) {
                    d3.select(this).style('display', 'none');
                    return;
                }
                
                const textElement = d3.select(this);
                
                // Calculate arc dimensions
                const arcAngle = d.x1 - d.x0; // radians
                const radius = (d.y0 + d.y1) / 2;
                const arcLength = arcAngle * radius * zoomLevel;
                const radialThickness = (d.y1 - d.y0) * zoomLevel;
                
                // Fixed font sizes based on depth
                const fontSizesByDepth = [0, 14, 12, 11, 10, 9];
                let fontSize = fontSizesByDepth[Math.min(d.depth, fontSizesByDepth.length - 1)] || 9;
                
                // Minimum arc length and thickness to show text
                const minArcLength = 40; // pixels
                const minThickness = 12; // pixels
                
                if (arcLength < minArcLength || radialThickness < minThickness) {
                    textElement.style('display', 'none');
                    return;
                }
                
                // Set font size and measure
                textElement.style('font-size', `${fontSize}px`);
                textElement.style('display', 'inline');
                
                const textWidth = this.getComputedTextLength();
                
                // Hide if text doesn't fit
                if (textWidth > arcLength * 0.9) {
                    textElement.style('display', 'none');
                } else {
                    textElement.style('display', 'inline');
                }
            });
    }

    clicked(event, p) {
        // If clicking on root (center), go back instead
        if (p.depth === 0) {
            this.goBack();
            return;
        }
        
        // Show details
        this.showFileDetails(p.data);
        
        // Store selection
        this.currentSelection = p;
        
        // Store selection history for back button
        if (!this.selectionHistory) {
            this.selectionHistory = [];
        }
        this.selectionHistory.push(p);
        
        // Zoom to the clicked node (standard sunburst pattern)
        this.zoomToNode(p);
        
        // Update arc strokes to highlight selection
        this.updateSelectionHighlight();
    }

    zoomToNode(p) {
        // Standard D3 sunburst zoom: rescale arcs so clicked node becomes the new "root"
        // Calculate the new scale and translation
        const newX = [p.x0, p.x1];
        const newY = [p.y0, this.radius];
        
        const k = this.radius / (newY[1] - newY[0]);
        const x = -newX[0] * k;
        
        // Update all arcs
        const arc = d3.arc()
            .startAngle(d => Math.max(0, Math.min(2 * Math.PI, (d.x0 - p.x0) / (p.x1 - p.x0) * 2 * Math.PI)))
            .endAngle(d => Math.max(0, Math.min(2 * Math.PI, (d.x1 - p.x0) / (p.x1 - p.x0) * 2 * Math.PI)))
            .innerRadius(d => Math.max(0, d.y0 - p.y0) * k)
            .outerRadius(d => Math.max(0, d.y1 - p.y0) * k);
        
        // Transition arcs
        this.g.selectAll('.sunburst-arc')
            .transition()
            .duration(750)
            .attrTween('d', d => () => arc(d));
        
        // Update text positions
        this.g.selectAll('.sunburst-text')
            .transition()
            .duration(750)
            .attrTween('transform', d => () => {
                const angle = ((d.x0 + d.x1) / 2 - p.x0) / (p.x1 - p.x0) * 2 * Math.PI;
                const angleDeg = angle * 180 / Math.PI;
                const radius = (((d.y0 + d.y1) / 2) - p.y0) * k;
                const rotation = angleDeg - 90;
                const finalRotation = rotation % 360;
                const needsFlip = finalRotation > 90 && finalRotation < 270;
                
                if (needsFlip) {
                    return `rotate(${rotation}) translate(${radius},0) rotate(180)`;
                } else {
                    return `rotate(${rotation}) translate(${radius},0)`;
                }
            })
            .on('end', () => {
                // Update label visibility after transition
                this.updateLabelVisibility(1);
            });
    }

    focusOnNode(p) {
        // Legacy method - keeping for compatibility
        this.zoomToNode(p);
    }

    goBack() {
        if (!this.selectionHistory || this.selectionHistory.length === 0) {
            // No history, reset to initial view
            this.resetView();
            return;
        }
        
        // Remove current selection
        this.selectionHistory.pop();
        
        if (this.selectionHistory.length === 0) {
            // No more history, reset to root
            this.currentSelection = null;
            this.resetView();
        } else {
            // Get parent (last item in history)
            const parent = this.selectionHistory[this.selectionHistory.length - 1];
            
            // Set as current selection
            this.currentSelection = parent;
            
            // Zoom to parent (without adding to history again)
            this.showFileDetails(parent.data);
            this.zoomToNode(parent);
        }
        
        // Update selection highlight
        this.updateSelectionHighlight();
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
