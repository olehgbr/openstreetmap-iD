import { event as d3_event, select as d3_select } from 'd3-selection';

import { geoVecLength } from '../geo';
import { modeBrowse } from '../modes/browse';
import { modeSelect } from '../modes/select';
import { modeSelectData } from '../modes/select_data';
import { modeSelectNote } from '../modes/select_note';
import { modeSelectError } from '../modes/select_error';
import { osmEntity, osmNote, QAItem } from '../osm';
import { utilFastMouse } from '../util/util';


export function behaviorSelect(context) {
    var _tolerancePx = 4; // see also behaviorDrag
    var _lastMouseEvent = null;
    var _showMenu = false;
    var _downPointers = {};
    var _longPressTimeout = null;
    var _lastInteractionType = null;

    // use pointer events on supported platforms; fallback to mouse events
    var _pointerPrefix = 'PointerEvent' in window ? 'pointer' : 'mouse';


    function keydown() {

        if (d3_event.keyCode === 32) {
            // don't react to spacebar events during text input
            var activeNode = document.activeElement;
            if (activeNode && new Set(['INPUT', 'TEXTAREA']).has(activeNode.nodeName)) return;
        }

        if (d3_event.keyCode === 93 ||  // context menu key
            d3_event.keyCode === 32) {  // spacebar
            d3_event.preventDefault();
        }

        if (d3_event.repeat) return; // ignore repeated events for held keys

        // if any key is pressed the user is probably doing something other than long-pressing
        cancelLongPress();

        if (d3_event.shiftKey) {
            context.surface()
                .classed('behavior-multiselect', true);
        }

        if (d3_event.keyCode === 32) {  // spacebar
            if (!_downPointers.spacebar && _lastMouseEvent) {
                cancelLongPress();
                _longPressTimeout = window.setTimeout(didLongPress, 500, 'spacebar', 'spacebar');

                _downPointers.spacebar = {
                    firstEvent: _lastMouseEvent,
                    lastEvent: _lastMouseEvent
                };
            }
        }
    }


    function keyup() {
        cancelLongPress();

        if (!d3_event.shiftKey) {
            context.surface()
                .classed('behavior-multiselect', false);
        }

        if (d3_event.keyCode === 93) {  // context menu key
            d3_event.preventDefault();
            _lastInteractionType = 'menukey';
            contextmenu();
        } else if (d3_event.keyCode === 32) {  // spacebar
            var pointer = _downPointers.spacebar;
            if (pointer) {
                delete _downPointers.spacebar;

                if (pointer.longPressed) return;

                d3_event.preventDefault();
                _lastInteractionType = 'spacebar';
                click(pointer.firstEvent, pointer.lastEvent);
            }
        }
    }


    function pointerdown() {
        var id = d3_event.pointerId || 'mouse';

        cancelLongPress();

        if (d3_event.buttons && d3_event.buttons !== 1) return;

        _longPressTimeout = window.setTimeout(didLongPress, 500, id, 'longdown-' + (d3_event.pointerType || 'mouse'));

        _downPointers[id] = {
            firstEvent: d3_event,
            lastEvent: d3_event
        };
    }


    function didLongPress(id, interactionType) {
        var pointer = _downPointers[id];
        if (!pointer) return;

        pointer.longPressed = true;

        // treat long presses like right-clicks
        _longPressTimeout = null;
        _lastInteractionType = interactionType;
        _showMenu = true;

        click(pointer.firstEvent, pointer.lastEvent);
    }


    function pointermove() {
        var id = d3_event.pointerId || 'mouse';
        if (_downPointers[id]) {
            _downPointers[id].lastEvent = d3_event;
        }
        if (!d3_event.pointerType || d3_event.pointerType === 'mouse') {
            _lastMouseEvent = d3_event;
            if (_downPointers.spacebar) {
                _downPointers.spacebar.lastEvent = d3_event;
            }
        }
    }


    function pointerup() {
        var id = d3_event.pointerId || 'mouse';
        var pointer = _downPointers[id];
        if (!pointer) return;

        delete _downPointers[id];

        if (pointer.longPressed) return;

        click(pointer.firstEvent, d3_event);
    }


    function contextmenu() {
        var e = d3_event;
        e.preventDefault();

        if (!+e.clientX && !+e.clientY) {
            if (_lastMouseEvent) {
                e.sourceEvent = _lastMouseEvent;
            } else {
                return;
            }
        } else {
            _lastMouseEvent = d3_event;
            _lastInteractionType = 'rightclick';
        }

        _showMenu = true;
        click(d3_event, d3_event);
    }


    function click(firstEvent, lastEvent) {
        cancelLongPress();

        var mapNode = context.container().select('.main-map').node();

        // Use the `main-map` coordinate system since the surface and supersurface
        // are transformed when drag-panning.
        var pointGetter = utilFastMouse(mapNode);
        var p1 = pointGetter(firstEvent);
        var p2 = pointGetter(lastEvent);
        var dist = geoVecLength(p1, p2);

        if (dist > _tolerancePx ||
            !mapContains(lastEvent)) {

            resetProperties();
            return;
        }

        var datum = lastEvent.target.__data__;
        // only support multiselect if data is already selected
        var isMultiselect = context.mode().id === 'select' &&
            ((d3_event && d3_event.shiftKey) || context.surface().select('.lasso').node() || isPointerDownOnSelection());

        processClick(datum, isMultiselect, p2);

        function mapContains(event) {
            var rect = mapNode.getBoundingClientRect();
            return event.clientX >= rect.left &&
                event.clientX <= rect.right &&
                event.clientY >= rect.top &&
                event.clientY <= rect.bottom;
        }
    }


    function isPointerDownOnSelection() {
        var selectedIds = context.mode().id === 'select' && context.mode().selectedIDs();
        for (var id in _downPointers) {
            if (id === 'spacebar') continue;

            var datum = _downPointers[id].firstEvent.target.__data__;
            var entity = (datum && datum.properties && datum.properties.entity) || datum;
            if (selectedIds.indexOf(entity.id) !== -1) return true;
        }
        return false;
    }


    function processClick(datum, isMultiselect, point) {
        var mode = context.mode();
        var showMenu = _showMenu;
        var interactionType = _lastInteractionType;

        var entity = datum && datum.properties && datum.properties.entity;
        if (entity) datum = entity;

        if (datum && datum.type === 'midpoint') {
            // treat targeting midpoints as if targeting the parent way
            datum = datum.parents[0];
        }

        var newMode;

        if (datum instanceof osmEntity) {    // clicked an entity..
            var selectedIDs = context.selectedIDs();
            context.selectedNoteID(null);
            context.selectedErrorID(null);

            if (!isMultiselect) {
                if (selectedIDs.length <= 1 || !showMenu) {
                    // always enter modeSelect even if the entity is already
                    // selected since listeners may expect `context.enter` events,
                    // e.g. in the walkthrough
                    newMode = mode.id === 'select' ? mode.selectedIDs([datum.id]) : modeSelect(context, [datum.id]);
                    context.enter(newMode);
                }

            } else {
                if (selectedIDs.indexOf(datum.id) !== -1) {
                    // clicked entity is already in the selectedIDs list..
                    if (!showMenu) {
                        // deselect clicked entity, then reenter select mode or return to browse mode..
                        selectedIDs = selectedIDs.filter(function(id) { return id !== datum.id; });
                        newMode = selectedIDs.length ? mode.selectedIDs(selectedIDs) : modeBrowse(context);
                        context.enter(newMode);
                    }
                } else {
                    // clicked entity is not in the selected list, add it..
                    selectedIDs = selectedIDs.concat([datum.id]);
                    newMode = mode.selectedIDs(selectedIDs);
                    context.enter(newMode);
                }
            }

        } else if (datum && datum.__featurehash__ && !isMultiselect) {    // clicked Data..
            context
                .selectedNoteID(null)
                .enter(modeSelectData(context, datum));

        } else if (datum instanceof osmNote && !isMultiselect) {    // clicked a Note..
            context
                .selectedNoteID(datum.id)
                .enter(modeSelectNote(context, datum.id));

        } else if (datum instanceof QAItem & !isMultiselect) {  // clicked an external QA issue
            context
                .selectedErrorID(datum.id)
                .enter(modeSelectError(context, datum.id, datum.service));

        } else {    // clicked nothing..
            context.selectedNoteID(null);
            context.selectedErrorID(null);
            if (!isMultiselect && mode.id !== 'browse') {
                context.enter(modeBrowse(context));
            }
        }

        context.ui().closeEditMenu();

        // always request to show the edit menu in case the mode needs it
        if (showMenu) context.ui().showEditMenu(point, interactionType);

        resetProperties();
    }


    function cancelLongPress() {
        if (_longPressTimeout) window.clearTimeout(_longPressTimeout);
        _longPressTimeout = null;
    }


    function resetProperties() {
        cancelLongPress();
        _showMenu = false;
        _lastInteractionType = null;
        // don't reset _lastMouseEvent since it might still be useful
    }


    function behavior(selection) {
        resetProperties();
        _lastMouseEvent = context.map().lastPointerEvent();

        d3_select(window)
            .on('keydown.select', keydown)
            .on('keyup.select', keyup)
            .on(_pointerPrefix + 'move.select', pointermove, true)
            .on(_pointerPrefix + 'up.select', pointerup, true)
            .on('contextmenu.select-window', function() {
                // Edge and IE really like to show the contextmenu on the
                // menubar when user presses a keyboard menu button
                // even after we've already preventdefaulted the key event.
                var e = d3_event;
                if (+e.clientX === 0 && +e.clientY === 0) {
                    d3_event.preventDefault();
                }
            });

        selection
            .on(_pointerPrefix + 'down.select', pointerdown)
            .on('contextmenu.select', contextmenu);

        if (d3_event && d3_event.shiftKey) {
            context.surface()
                .classed('behavior-multiselect', true);
        }
    }


    behavior.off = function(selection) {
        cancelLongPress();

        d3_select(window)
            .on('keydown.select', null)
            .on('keyup.select', null)
            .on('contextmenu.select-window', null)
            .on(_pointerPrefix + 'move.select', null, true)
            .on(_pointerPrefix + 'up.select', null, true);

        selection
            .on(_pointerPrefix + 'down.select', null)
            .on('contextmenu.select', null);

        context.surface()
            .classed('behavior-multiselect', false);
    };


    return behavior;
}
