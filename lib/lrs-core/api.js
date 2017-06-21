/**
 * Copyright ©2016. The Regents of the University of California (Regents). All Rights Reserved.
 *
 * Permission to use, copy, modify, and distribute this software and its documentation
 * for educational, research, and not-for-profit purposes, without fee and without a
 * signed licensing agreement, is hereby granted, provided that the above copyright
 * notice, this paragraph and the following two paragraphs appear in all copies,
 * modifications, and distributions.
 *
 * Contact The Office of Technology Licensing, UC Berkeley, 2150 Shattuck Avenue,
 * Suite 510, Berkeley, CA 94720-1620, (510) 643-7201, otl@berkeley.edu,
 * http://ipira.berkeley.edu/industry-info for commercial licensing opportunities.
 *
 * IN NO EVENT SHALL REGENTS BE LIABLE TO ANY PARTY FOR DIRECT, INDIRECT, SPECIAL,
 * INCIDENTAL, OR CONSEQUENTIAL DAMAGES, INCLUDING LOST PROFITS, ARISING OUT OF
 * THE USE OF THIS SOFTWARE AND ITS DOCUMENTATION, EVEN IF REGENTS HAS BEEN ADVISED
 * OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * REGENTS SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. THE
 * SOFTWARE AND ACCOMPANYING DOCUMENTATION, IF ANY, PROVIDED HEREUNDER IS PROVIDED
 * "AS IS". REGENTS HAS NO OBLIGATION TO PROVIDE MAINTENANCE, SUPPORT, UPDATES,
 * ENHANCEMENTS, OR MODIFICATIONS.
 */

var _ = require('lodash');
var config = require('config');
var express = require('express');
var fs = require('fs');
var path = require('path');
var util = require('util');

var UsersAPI = require('../lrs-users/api');

var DB = require('./db');
var logger = module.exports.logger = require('./logger');
var log = logger('lrs-core');
var Modules = require('./modules');
var Server = require('./server');
module.exports.addSafePathPrefix = Server.addSafePathPrefix;

/**
 * Initialize the Learning Record Store
 *
 * @param  {Function}       callback            Standard callback function
 * @param  {Object}         callback.err        An error object, if any
 */
var init = module.exports.init = function(callback) {
  // Apply global utilities
  require('./globals');

  // All unexpected or uncaught errors will be caught and logged here. At this point we cannot
  // guarantee that the system is functioning properly anymore so we kill the process. When running
  // in production, the service script will automatically respawn the instance
  process.on('uncaughtException', function(err) {
    log.error({'err': err}, 'Uncaught exception was raised, restarting the process');
    process.exit(1);
  });

  // Initialize the database
  DB.init(function() {
    // Initialize the modules
    Modules.init(function() {
      // Initialize the Express server
      initializeServer();

      return callback();
    });
  });
};

/**
 * Initialize the Learning Record Store app server and initialize the REST API endpoints
 *
 * @api private
 */
var initializeServer = function() {
  // Initialize the Express server
  var appServer = module.exports.appServer = Server.setUpServer();

  // A router for all routes on /api
  var apiRouter = module.exports.apiRouter = express.Router();

  initializeAuthorizationMiddleware(apiRouter);

  appServer.use('/api/:apidomain/:course', apiRouter);

  // Check if a `rest.js` file exists in the `lib` folder of each
  // module. If such a file exists, we require it. This allows other
  // modules to add in their own REST apis
  var lrsModules = Modules.getAvailableModules();
  _.each(lrsModules, function(module) {
    var restFile = path.join(__dirname, '..', module, '/rest.js');
    if (fs.existsSync(restFile)) {
      log.debug({'module': module}, util.format('Registering REST APIs for %s', module));
      require(restFile);
    }
  });
  log.info('Finished initializing REST APIs');
};

/**
 * Writing new learning activity statements to the Learning Record Store and querying
 * the Learning Record Store can happen through distributed Basic Auth keys and secrets.
 * However, a user can also individually be authorized to interact with a subset of the
 * REST services through a valid LTI launch of the privacy dashboard. When a successful
 * LTI launch has taken place, a cookie will be set to identify the user and its tenant
 * to the REST API.
 *
 * @param  {Object}         apiRouter       The router for all routes on /api/
 * @api private
 */
var initializeAuthorizationMiddleware = function(apiRouter) {

  apiRouter.use(function(req, res, next) {
    // If the request already has a context object, a successful bookmarklet token has taken
    // place and we can continue moving through the middleware
    if (req.ctx) {
      return next();
    }

    // TODO This presumes that all APIs will be scoped by a Canvas course site and the authenticated user.
    // Instead, we anticipate report scoping by Tenant Domain and a target user.

    // Extract the API domain and course id from the API URL. The expected format for all API urls
    // is `/api/ucberkeley.canvas.com/21312`
    var apiDomain = decodeURIComponent(req.baseUrl.split('/')[2]);
    var courseId = decodeURIComponent(req.baseUrl.split('/')[3]);

    // Get the user id from the client's cookies. As a user can have multiple tools open
    // in multiple courses, we have a cookie per domain/course tuple
    var cookieName = encodeURIComponent(apiDomain + '_' + courseId);
    var userId = req.signedCookies[cookieName];

    // If no user id could be found, we bail out immediately
    if (!userId) {
      return res.status(401).send('Incorrect cookie information present');
    }

    // Get the user
    UsersAPI.getUser(userId, function(err, user) {
      if (err) {
        return next(err);
      }

      // Add the user and its tenant to the
      // request context object
      req.ctx = req.ctx || {};
      req.ctx.user = user;

      return next();
    });
  });
};