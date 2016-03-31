import {moduleName} from '../../../config';

import Queue from './../../support/Queue';
import SimpleMap from './../../support/SimpleMap';
import BaseDelegate from './BaseDelegate';

/**
 * @ngdoc event
 * @module knalli.angular-vertxbus
 * @eventOf knalli.angular-vertxbus.vertxEventBusService
 * @eventType broadcast on $rootScope
 * @name disconnected
 *
 * @description
 * After a connection was being terminated.
 *
 * Event name is `prefix + 'system.disconnected'` (see {@link knalli.angular-vertxbus.vertxEventBusServiceProvider#methods_usePrefix prefix})
 */

/**
 * @ngdoc event
 * @module knalli.angular-vertxbus
 * @eventOf knalli.angular-vertxbus.vertxEventBusService
 * @eventType broadcast on $rootScope
 * @name connected
 *
 * @description
 * After a connection was being established
 *
 * Event name is `prefix + 'system.connected'` (see {@link knalli.angular-vertxbus.vertxEventBusServiceProvider#methods_usePrefix prefix})
 */

/**
 * @ngdoc event
 * @module knalli.angular-vertxbus
 * @eventOf knalli.angular-vertxbus.vertxEventBusService
 * @eventType broadcast on $rootScope
 * @name login-succeeded
 *
 * @description
 * After a login has been validated successfully
 *
 * Event name is `prefix + 'system.login.succeeded'` (see {@link knalli.angular-vertxbus.vertxEventBusServiceProvider#methods_usePrefix prefix})
 *
 * @param {object} data data
 * @param {boolean} data.status must be `'ok'`
 */

/**
 * @ngdoc event
 * @module knalli.angular-vertxbus
 * @eventOf knalli.angular-vertxbus.vertxEventBusService
 * @eventType broadcast on $rootScope
 * @name login-failed
 *
 * @description
 * After a login has been destroyed or was invalidated
 *
 * Event name is `prefix + 'system.login.failed'` (see {@link knalli.angular-vertxbus.vertxEventBusServiceProvider#methods_usePrefix prefix})
 *
 * @param {object} data data
 * @param {boolean} data.status must be not`'ok'`
 */

export default class EventBusDelegate extends BaseDelegate {

  constructor($rootScope, $interval, $log, $q, eventBus, {
    enabled,
    debugEnabled,
    prefix,
    sockjsStateInterval,
    messageBuffer,
    loginRequired,
    loginInterceptor
    }) {
    super();
    this.$rootScope = $rootScope;
    this.$interval = $interval;
    this.$log = $log;
    this.$q = $q;
    this.eventBus = eventBus;
    this.options = {
      enabled,
      debugEnabled,
      prefix,
      sockjsStateInterval,
      messageBuffer,
      loginRequired
    };
    this.loginInterceptor = loginInterceptor;
    this.connectionState = this.eventBus.EventBus.CLOSED;
    this.states = {
      connected: false,
      validSession: false
    };
    this.observers = [];
    // internal store of buffered messages
    this.messageQueue = new Queue(this.options.messageBuffer);
    // internal map of callbacks
    this.callbackMap = new SimpleMap();
    // asap
    this.initialize();
  }

  // internal
  initialize() {
    this.eventBus.onopen = () => this.onEventbusOpen();
    this.eventBus.onclose = () => this.onEventbusClose();

    // Update the current connection state periodically.
    let connectionIntervalCheck = () => this.getConnectionState(true);
    connectionIntervalCheck.displayName = 'connectionIntervalCheck';
    this.$interval((() => connectionIntervalCheck()), this.options.sockjsStateInterval);
  }

  // internal
  onEventbusOpen() {
    let connectionStateFlipped = false;
    this.getConnectionState(true);
    if (!this.states.connected) {
      this.states.connected = true;
      connectionStateFlipped = true;
    }
    // Ensure all events will be re-attached
    this.afterEventbusConnected();
    // Everything is online and registered again, let's notify everybody
    if (connectionStateFlipped) {
      this.$rootScope.$broadcast(`${this.options.prefix}system.connected`);
    }
    this.$rootScope.$digest(); // explicitly
    // consume message queue?
    if (this.options.messageBuffer && this.messageQueue.size()) {
      while (this.messageQueue.size()) {
        let fn = this.messageQueue.first();
        if (angular.isFunction(fn)) {
          fn();
        }
      }
      this.$rootScope.$digest();
    }
  }

  // internal
  onEventbusClose() {
    this.getConnectionState(true);
    if (this.states.connected) {
      this.states.connected = false;
      this.$rootScope.$broadcast(`${this.options.prefix}system.disconnected`);
    }
  }

  // internal
  observe(observer) {
    this.observers.push(observer);
  }

  // internal
  afterEventbusConnected() {
    for (let observer of this.observers) {
      if (angular.isFunction(observer.afterEventbusConnected)) {
        observer.afterEventbusConnected();
      }
    }
  }

  registerHandler(address, headers, callback) {
    if (angular.isFunction(headers) && !callback) {
      callback = headers;
      headers = undefined;
    }
    if (!angular.isFunction(callback)) {
      return;
    }
    if (this.options.debugEnabled) {
      this.$log.debug(`[Vert.x EB Service] Register handler for ${address}`);
    }
    var callbackWrapper = (err, {body}, replyTo) => {
      callback(body, replyTo);
      this.$rootScope.$digest();
    };
    callbackWrapper.displayName = `${moduleName}.service.delegate.live.registerHandler.callbackWrapper`;
    this.callbackMap.put(callback, callbackWrapper);
    return this.eventBus.registerHandler(address, headers, callbackWrapper);
  }

  unregisterHandler(address, headers, callback) {
    if (angular.isFunction(headers) && !callback) {
      callback = headers;
      headers = undefined;
    }
    if (!angular.isFunction(callback)) {
      return;
    }
    if (this.options.debugEnabled) {
      this.$log.debug(`[Vert.x EB Service] Unregister handler for ${address}`);
    }
    this.eventBus.unregisterHandler(address, headers, this.callbackMap.get(callback));
    this.callbackMap.remove(callback);
  }

  send(address, message, headers, timeout = 10000, expectReply = true) {
    let deferred = this.$q.defer();
    let next = () => {
      if (expectReply) {
        // Register timeout for promise rejecting
        let timer = this.$interval((() => {
          if (this.options.debugEnabled) {
            this.$log.debug(`[Vert.x EB Service] send('${address}') timed out`);
          }
          deferred.reject();
        }), timeout, 1);
        // Send message
        this.eventBus.send(address, message, headers, (err, reply) => {
          this.$interval.cancel(timer); // because it's resolved
          if (err) {
            deferred.reject(err);
          } else {
            deferred.resolve(reply);
          }
        });
      } else {
        this.eventBus.send(address, message, headers);
        deferred.resolve(); // we don't care
      }
    };
    next.displayName = `${moduleName}.service.delegate.live.send.next`;
    if (!this.ensureOpenAuthConnection(next)) {
      deferred.reject();
    }
    return deferred.promise;
  }

  publish(address, message, headers) {
    return this.ensureOpenAuthConnection(() => this.eventBus.publish(address, message, headers));
  }

  /**
   * Ensures the callback will be performed with an open connection.
   *
   * Unless an open connection was found, the callback will be queued in the message buffer (if available).
   *
   * @param {function} fn callback
   * @returns {boolean} false if the callback cannot be performed or queued
   */
  ensureOpenConnection(fn) {
    if (this.isConnectionOpen()) {
      fn();
      return true;
    } else if (this.options.messageBuffer) {
      this.messageQueue.push(fn);
      return true;
    }
    return false;
  }

  /**
   * Ensures the callback will be performed with a valid session.
   *
   * Unless `loginRequired` is enabled, this will be simple forward.
   *
   * Unless a valid session exist (but required), the callback will be not invoked.
   *
   * @param {function} fn callback
   * @returns {boolean} false if the callback cannot be performed or queued
   */
  ensureOpenAuthConnection(fn) {
    if (!this.options.loginRequired) {
      // easy: no login required
      return this.ensureOpenConnection(fn);
    } else {
      let fnWrapper = () => {
        if (this.states.validSession) {
          fn();
          return true;
        } else {
          // ignore this message
          if (this.options.debugEnabled) {
            this.$log.debug('[Vert.x EB Service] Message was not sent because login is required');
          }
          return false;
        }
      };
      fnWrapper.displayName = `${moduleName}.service.delegate.live.ensureOpenAuthConnection.fnWrapper`;
      return this.ensureOpenConnection(fnWrapper);
    }
  }

  /**
   * Returns the current connection state. The state is being cached internally.
   *
   * @param {boolean=} [immediate=false] if true, the connection state will be queried directly.
   * @returns {number} state type of vertx.EventBus
   */
  getConnectionState(immediate) {
    if (this.options.enabled) {
      if (immediate) {
        this.connectionState = this.eventBus.state;
      }
    } else {
      this.connectionState = this.eventBus.EventBus.CLOSED;
    }
    return this.connectionState;
  }

  /**
   * Returns true if the current connection state ({@link knalli.angular-vertxbus.vertxEventBusService#methods_getConnectionState getConnectionState()}) is `OPEN`.
   *
   * @returns {boolean} connection open state
   */
  isConnectionOpen() {
    return this.getConnectionState() === this.eventBus.EventBus.OPEN;
  }

  /**
   * Returns true if the session is valid
   *
   * @returns {boolean} state
   */
  isValidSession() {
    return this.states.validSession;
  }

  // internal
  isConnected() {
    return this.states.connected;
  }

  isEnabled() {
    return this.options.enabled;
  }

  /**
   * Returns the current amount of messages in the internal buffer.
   *
   * @returns {number} amount
   */
  getMessageQueueLength() {
    return this.messageQueue.size();
  }

}
