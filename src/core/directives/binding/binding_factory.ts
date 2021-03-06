import { ComponentMetadata, DirectiveMetadata } from '../metadata_directives';

import { isComponentDirective } from '../directives_utils';

import { SimpleChange, ChangeDetectionUtil } from '../../change_detection/change_detection_util';
import { changesQueueService } from '../../change_detection/changes_queue';

import { StringMapWrapper } from '../../../facade/collections';
import { global, noop, isString, isBoolean, isFunction } from '../../../facade/lang';
import { EventEmitter } from '../../../facade/async';

import { ParsedBindingValue, BINDING_MODE } from './constants';
import { _parseBindings } from './binding_parser';

/**
 * Create Bindings manually for both Directive/Component
 * @param hasIsolateScope
 * @param _scope
 * @param attributes
 * @param ctrl
 * @param metadata
 * @param {{$interpolate,$parse,$rootScope}}
 * @returns {{watchers: Array, observers: Array}}
 * @internal
 * @private
 */
export function _createDirectiveBindings(
  hasIsolateScope: boolean,
  _scope: ng.IScope,
  attributes: ng.IAttributes,
  ctrl: any,
  metadata: ComponentMetadata|DirectiveMetadata,
  { $interpolate, $parse, $rootScope }: {
    $interpolate?: ng.IInterpolateService,
    $parse?: ng.IParseService,
    $rootScope?: ng.IRootScopeService
  }
): {
  initialChanges: {[key: string]: SimpleChange},
  removeWatches: Function,
  _watchers: {watchers: Function[], observers: Function[]}
} {

  /*  let BOOLEAN_ATTR = {};
   'multiple,selected,checked,disabled,readOnly,required,open'
   .split(',')
   .forEach(function(value) {
   BOOLEAN_ATTR[value.toLocaleLowerCase()] = value;
   });*/

  const isBindingImmutable = isComponentDirective( metadata ) && ChangeDetectionUtil.isOnPushChangeDetectionStrategy( metadata.changeDetection );
  const scope = hasIsolateScope
    ? _scope.$parent
    : _scope;
  const { inputs=[], outputs=[], attrs=[] } = metadata;
  const parsedBindings = _parseBindings( { inputs, outputs, attrs } );
  const _internalWatchers = [];
  const _internalObservers = [];

  // onChanges tmp vars
  const initialChanges = {} as {[key: string]: SimpleChange};
  let changes;

  // this will create flush queue internally only once
  // we need to call this here because we need $rootScope service
  changesQueueService.buildFlushOnChanges( $rootScope );

  // setup @Inputs '<' or '='
  // by default '='
  // @TODO starting 2.0 there will be no default, if no explicit type provided it will be determined from template
  StringMapWrapper.forEach( parsedBindings.inputs, ( config: ParsedBindingValue, propName: string ) => {

    const { alias, optional, mode } = config;
    const attrName = alias || propName;
    const hasTwoWayBinding = hasIsolateScope && mode === BINDING_MODE.twoWay;

    const removeWatch = hasTwoWayBinding
      ? _createTwoWayBinding( propName, attrName, optional )
      : _createOneWayBinding( propName, attrName, optional, isBindingImmutable );
    _internalWatchers.push( removeWatch );

  } );

  // setup @Outputs
  StringMapWrapper.forEach( parsedBindings.outputs, ( config: ParsedBindingValue, propName: string ) => {

    const { alias, optional, mode } = config;
    const attrName = alias || propName;

    _createOutputBinding( propName, attrName, optional );

  } );

  // setup @Attrs
  StringMapWrapper.forEach( parsedBindings.attrs, ( config: ParsedBindingValue, propName: string ) => {

    const { alias, optional, mode } = config;
    const attrName = alias || propName;

    const removeObserver = _createAttrBinding( attrName, propName, optional );
    _internalObservers.push( removeObserver );

  } );

  function _createOneWayBinding( propName: string, attrName: string, optional: boolean, isImmutable: boolean = false ): Function {

    if ( !Object.hasOwnProperty.call( attributes, attrName ) ) {
      if ( optional ) return;
      attributes[ attrName ] = void 0;
    }
    if ( optional && !attributes[ attrName ] ) return;

    const parentGet = $parse( attributes[ attrName ] );

    ctrl[ propName ] = parentGet( scope );
    initialChanges[ propName ] = ChangeDetectionUtil.simpleChange( ChangeDetectionUtil.uninitialized, ctrl[ propName ] );

    return scope.$watch( parentGet, function parentValueWatchAction( newParentValue ) {
      const oldValue = ctrl[ propName ];
      recordChanges( propName, newParentValue, oldValue );
      ctrl[ propName ] = isImmutable ? angular.copy(newParentValue) : newParentValue;
    }, parentGet.literal );

  }
  function _createTwoWayBinding( propName: string, attrName: string, optional: boolean ): Function {

    let lastValue;

    if ( !Object.hasOwnProperty.call( attributes, attrName ) ) {
      if ( optional ) return;
      attributes[ attrName ] = void 0;
    }
    if ( optional && !attributes[ attrName ] ) return;

    let compare;
    const parentGet = $parse( attributes[ attrName ] );
    if (parentGet.literal) {
      compare = global.angular.equals;
    } else {
      compare = function simpleCompare(a, b) { return a === b || (a !== a && b !== b); };
    }
    const parentSet = parentGet.assign || function() {
        // reset the change, or we will throw this exception on every $digest
        lastValue = ctrl[propName] = parentGet(scope);
        throw new Error(
          `nonassign,
          Expression '${attributes[ attrName ]}' in attribute '${attrName}' used with directive '{2}' is non-assignable!`
        );
      };
    lastValue = ctrl[propName] = parentGet(scope);
    const parentValueWatch = function parentValueWatch(parentValue) {
      if (!compare(parentValue, ctrl[propName])) {
        // we are out of sync and need to copy
        if (!compare(parentValue, lastValue)) {
          // parent changed and it has precedence
          ctrl[propName] = parentValue;
        } else {
          // if the parent can be assigned then do so
          parentSet(scope, parentValue = ctrl[propName]);
        }
      }
      return lastValue = parentValue;
    };
    (parentValueWatch as any).$stateful = true;
    // NOTE: we don't support collection watch, it's not good for performance
    // if (definition.collection) {
    //   removeWatch = scope.$watchCollection(attributes[attrName], parentValueWatch);
    // } else {
    //   removeWatch = scope.$watch($parse(attributes[attrName], parentValueWatch), null, parentGet.literal);
    // }
    // removeWatchCollection.push(removeWatch);
    return scope.$watch(
      $parse( attributes[ attrName ], parentValueWatch ),
      null,
      parentGet.literal
    );

  }
  function _createOutputBinding( propName: string, attrName: string, optional: boolean ): void {

    // Don't assign Object.prototype method to scope
    const parentGet: Function = attributes.hasOwnProperty( attrName )
      ? $parse( attributes[ attrName ] )
      : noop;

    // Don't assign noop to ctrl if expression is not valid
    if (parentGet === noop && optional) return;

    // @TODO in ngMetadata 2.0 this will be removed
    EventEmitter.makeNgExpBindingEmittable( _exprBindingCb );

    // @TODO in ngMetadata 2.0 we will assign this property to EventEmitter directly
    // const emitter = new EventEmitter();
    // emitter.wrapNgExpBindingToEmitter( _exprBindingCb );
    // ctrl[propName] = emitter;

    ctrl[propName] = _exprBindingCb;

    function _exprBindingCb( locals ) {
      return parentGet( scope, locals );
    }

  }
  function _createAttrBinding( attrName: string, propName: string, optional: boolean ): Function {

    let lastValue;

    if ( !optional && !Object.hasOwnProperty.call( attributes, attrName ) ) {
      ctrl[ propName ] = attributes[ attrName ] = void 0;
    }

    // register watchers for further changes
    // The observer function will be invoked once during the next $digest following compilation.
    // The observer is then invoked whenever the interpolated value changes.

    const _disposeObserver = attributes.$observe( attrName, function ( value ) {
      if ( isString( value ) ) {
        const oldValue = ctrl[ propName ];
        recordChanges( propName, value, oldValue );
        ctrl[ propName ] = value;
      }
    } );

    (attributes as any).$$observers[ attrName ].$$scope = scope;
    lastValue = attributes[ attrName ];
    if ( isString( lastValue ) ) {
      // If the attribute has been provided then we trigger an interpolation to ensure
      // the value is there for use in the link fn
      ctrl[ propName ] = $interpolate( lastValue )( scope );
    } else if ( isBoolean( lastValue ) ) {
      // If the attributes is one of the BOOLEAN_ATTR then Angular will have converted
      // the value to boolean rather than a string, so we special case this situation
      ctrl[ propName ] = lastValue;
    }

    initialChanges[ propName ] = ChangeDetectionUtil.simpleChange( ChangeDetectionUtil.uninitialized, ctrl[ propName ] );
    return _disposeObserver;

  }

  function recordChanges<T>( key: string, currentValue: T, previousValue: T ): void {
    if (isFunction(ctrl.ngOnChanges) && currentValue !== previousValue) {
      // If we have not already scheduled the top level onChangesQueue handler then do so now
      if (!changesQueueService.onChangesQueue) {
        scope.$$postDigest(changesQueueService.flushOnChangesQueue);
        changesQueueService.onChangesQueue = [];
      }
      // If we have not already queued a trigger of onChanges for this controller then do so now
      if (!changes) {
        changes = {};
        changesQueueService.onChangesQueue.push(triggerOnChangesHook);
      }
      // If the has been a change on this property already then we need to reuse the previous value
      if (changes[key]) {
        previousValue = changes[key].previousValue;
      }
      // Store this change
      changes[key] = ChangeDetectionUtil.simpleChange(previousValue, currentValue);
    }
  }

  function triggerOnChangesHook(): void {
    ctrl.ngOnChanges( changes );
    // Now clear the changes so that we schedule onChanges when more changes arrive
    changes = undefined;
  }

  function removeWatches(): void {
    const removeWatchCollection = [ ..._internalWatchers, ..._internalObservers ];
    for ( var i = 0, ii = removeWatchCollection.length; i < ii; ++i ) {
      if (removeWatchCollection[ i ] && isFunction(removeWatchCollection[ i ])) {
        removeWatchCollection[ i ]();
      }
    }
  }

  return {
    initialChanges,
    removeWatches,
    _watchers: { watchers: _internalWatchers, observers: _internalObservers }
  };

}
