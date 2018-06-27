/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};
/******/
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/
/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId]) {
/******/ 			return installedModules[moduleId].exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			i: moduleId,
/******/ 			l: false,
/******/ 			exports: {}
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/
/******/ 		// Flag the module as loaded
/******/ 		module.l = true;
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/******/
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;
/******/
/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;
/******/
/******/ 	// define getter function for harmony exports
/******/ 	__webpack_require__.d = function(exports, name, getter) {
/******/ 		if(!__webpack_require__.o(exports, name)) {
/******/ 			Object.defineProperty(exports, name, {
/******/ 				configurable: false,
/******/ 				enumerable: true,
/******/ 				get: getter
/******/ 			});
/******/ 		}
/******/ 	};
/******/
/******/ 	// getDefaultExport function for compatibility with non-harmony modules
/******/ 	__webpack_require__.n = function(module) {
/******/ 		var getter = module && module.__esModule ?
/******/ 			function getDefault() { return module['default']; } :
/******/ 			function getModuleExports() { return module; };
/******/ 		__webpack_require__.d(getter, 'a', getter);
/******/ 		return getter;
/******/ 	};
/******/
/******/ 	// Object.prototype.hasOwnProperty.call
/******/ 	__webpack_require__.o = function(object, property) { return Object.prototype.hasOwnProperty.call(object, property); };
/******/
/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "";
/******/
/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(__webpack_require__.s = 0);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


var path = __webpack_require__(1);
var express = __webpack_require__(2);
var app = express();
var server = __webpack_require__(3).Server(app);
var io = __webpack_require__(4)(server, { serveClient: false });
var fs = __webpack_require__(5);
var jwt = __webpack_require__(6);
var crypto = __webpack_require__(7);
var nodeCleanup = __webpack_require__(8);

nodeCleanup(function (exitCode, signal) {
  console.log('Shutting down server...');
  var applicationData = {
    users: usersCache,
    challenges: challengeCache,
    games: gamesInProgress
  };
  var fileContent = JSON.stringify(applicationData, null, 2);
  fs.writeFileSync('./ApplicationData.json', fileContent);
  console.log('Data saved');
  console.log('Goodbye!');
});

var bcrypt = __webpack_require__(9);
var saltRounds = 10;
var jwtSigningSecret = 'RoyalGameOfUr';

var Game = __webpack_require__(10);
var CONFIG = __webpack_require__(12);

// Serve the static content directly.
app.use(express.static(__dirname));
app.use(express.static(__dirname + '/static'));

app.get('/', function (req, res) {
  res.sendFile(__dirname + '/index.html');
});

server.listen({ port: CONFIG.PORT }, function () {
  console.log('Listening on *:' + CONFIG.PORT);
});

// Models.
/**
 * Represents a user, should never be sent to the client as it contains sensitive
 * information.
 * @type {{id: number, name: string, email: string, password: string}}
 */
var UserModel = {};

/**
 * Represents a player, it is a stripped down version of the UserModel that doesn't
 * contain sensitive information.
 * @type {{id: number, name: string}}
 */
var PlayerModel = {};

var availablePlayers = {};

/**
 * Keyed by the Game ID with the game being the value.
 * @type {{}}
 */
var gamesInProgress = {};

/**
 * Keyed by the User ID, values are arrays containing Game IDs.
 * @type {{}}
 */
var playerGamesInProgress = {};

/**
 * A list of authenticated players in the lobby.
 * @type {{number: {id: number, name: string}}}
 */
var lobbyPlayers = {};

// socket.id => player.id
var socketIdsToPlayerIds = {};
// player.id => socket.id
var playerIdsToSocketIds = {};

// Prepare various caches.

/**
 * A cache of all user accounts.
 * @type {UserModel[]}
 */
var usersCache = [];

/**
 * A cache of all pending challenges.
 * @type {{id: string, from: number, to: number}}
 */
var challengeCache = {};
var sequences = {
  users: 0
};
if (fs.existsSync('./ApplicationData.json')) {
  var fileContent = fs.readFileSync('./ApplicationData.json');
  var applicationData = JSON.parse(fileContent);
  usersCache = applicationData.users;
  challengeCache = applicationData.challenges;
  sequences.users = applicationData.users.length;

  // Hydrate the game data back into objects that have functions.
  var rawGames = applicationData.games;
  var gameIds = Object.keys(rawGames);
  var gamesObjectified = {};
  for (var i = 0; i < gameIds.length; i++) {
    var gameData = rawGames[gameIds[i]];
    var newGameObject = new Game(gameData.player1.pid, gameData.player2.pid);

    // Copy the server state onto the client state.
    var gameProperties = ['id', 'turn', 'track', 'state', 'player1', 'player2', 'currentRoll', 'currentPlayer'];

    for (var p = 0; p < gameProperties.length; p++) {
      newGameObject[gameProperties[p]] = gameData[gameProperties[p]];
    }

    gamesObjectified[newGameObject.id] = newGameObject;
  }
  gamesInProgress = gamesObjectified;
}

io.on('connection', function (socket) {

  socket.on('disconnect', function () {
    // Handle the exit gracefully.
    setupGuest(socket);
  });

  // Check to see if the user is connecting with a remember token.
  var token = socket.handshake.query.rememberToken;

  if (token) {
    console.log(socket.id, 'connected with token');
    var tokenUser = getUserFromToken(token);

    if (tokenUser) {
      console.log(socket.id, 'token valid', tokenUser.id, tokenUser.name);
      // Tell the player they've logged in.
      socket.emit('auth-login-success', {
        id: tokenUser.id,
        name: tokenUser.name
      });

      setupPlayer(socket, tokenUser);
    } else {
      // todo: tell the client to destroy their token
      console.log(socket.id, 'token invalid');
      setupGuest(socket);
    }
  } else {
    setupGuest(socket);
  }

  function authLogin(payload) {
    console.log('authLogin ' + socket.id);

    // Retrieve user record.
    var loggingInAs = getUserByProperty('email', payload.email);

    if (!loggingInAs) {
      // todo: do a hash here anyway
      console.log('authLogin failure ' + socket.id);
      socket.emit('auth-login-failure', 'invalid username or password');
      return;
    }

    var hashOnRecord = loggingInAs['password'];

    bcrypt.compare(payload.password, hashOnRecord, function (err, res) {
      if (res === true) {
        // Did the user want to be remembered?
        var rememberToken = null;

        if (payload.remember === true) {
          // Generate the token using JWT (we can prevent tampering).
          // Stop the users email being readable in the JWT.
          var emailHash = crypto.createHash('sha256').update(loggingInAs.email).digest('hex');
          rememberToken = jwt.sign({
            userId: loggingInAs.id,
            userEmailHash: emailHash,
            userPasswordHash: loggingInAs.password
          }, jwtSigningSecret, {
            expiresIn: '7d'
          });
        }

        // Success.
        console.log('authLogin success ' + socket.id);
        socket.emit('auth-login-success', {
          id: loggingInAs['id'],
          name: loggingInAs['name'],
          rememberToken: rememberToken
        });

        setupPlayer(socket, loggingInAs);
      } else {
        // Failure.
        console.log('authLogin failure ' + socket.id);
        socket.emit('auth-login-failure', 'invalid username or password');
      }
    });
  }

  function getUserFromToken(token) {
    // Decode the token.
    try {
      var payload = jwt.verify(token, jwtSigningSecret);
      var userId = payload.userId;

      var userOnRecord = getUserById(userId);

      // Verify that the user exists.
      if (!userOnRecord) {
        console.log(socket.id, 'token check user failed');
        return null;
      }

      // Verify that this is the right user for the token.
      if (payload.userPasswordHash !== userOnRecord['password']) {
        // The password hash didn't match. Either someone tampered with the token
        // or the user changed their password (they should log in again).
        console.log(socket.id, 'token check password failed');
        return null;
      }

      // Verify that the email hash is right for the user token.
      var existingEmailHash = crypto.createHash('sha256').update(userOnRecord['email']).digest('hex');

      if (existingEmailHash !== payload.userEmailHash) {
        // The token was likely tampered in this case.
        console.log(socket.id, 'token check email failed');
        return null;
      }

      // Everything looks good from here.
      return userOnRecord;
    } catch (err) {
      return null;
    }
  }

  function authRegister(payload) {
    console.log('authRegister ' + socket.id);

    var formValid = payload.email && payload.name && payload.password;
    var passwordConfirmed = payload.password === payload.passwordAgain;
    var emailInUse = getUserByProperty('email', payload.email) !== null;
    var hashedPassword = bcrypt.hashSync(payload.password, saltRounds);

    console.log('after has result', hashedPassword);

    // Verify that we have an email, username, password, and confirmation.
    if (!formValid || !passwordConfirmed || hashedPassword === null || emailInUse) {
      var failureReason = 'unknown';
      if (!formValid) {
        failureReason = 'missing fields';
      } else if (!passwordConfirmed) {
        failureReason = 'passwords do not match';
      } else if (hashedPassword === null) {
        failureReason = 'server error';
      } else if (emailInUse) {
        failureReason = 'email in use';
      }

      console.log('authRegister failed ' + socket.id + ' ' + failureReason);
      socket.emit('auth-register-failure', failureReason);
      return;
    }
    console.log('authRegister success ' + socket.id);

    var newUser = {
      id: sequences.users++,
      name: payload.name,
      email: payload.email,
      password: hashedPassword
    };

    usersCache.push(newUser);

    socket.emit('auth-register-success', {
      id: newUser.id,
      name: newUser.name
    });
  }

  function authLogout(socket) {
    console.log('logging out', socket.userId, socket.id);
    setupGuest(socket);
    socket.emit('auth-logout');
  }

  /**
   *
   * @param socket
   * @param {{id: number, name: string}} player
   */
  function setupPlayer(socket, player) {
    console.log('setting up player', player.name, socket.id);

    // Store some references that make converting between socket
    // and players a little easier.
    playerIdsToSocketIds[player.id] = socket.id;
    socketIdsToPlayerIds[socket.id] = player.id;

    // Remove guest events.
    socket.removeListener('login', authLogin);
    socket.removeListener('register', authRegister);

    // Registers player events.
    socket.on('logout', function () {
      authLogout(socket);
    });
    socket.on('challenge-create', function (playerId) {
      challengePlayer(socket, playerId);
    });
    socket.on('lobby-challenge-accept', challengeAccepted);
    socket.on('lobby-challenge-reject', challengeRejected);
    socket.on('game-select', function (gameId) {
      gameSelect(socket, gameId);
    });
    socket.on('game-roll', function (gameId) {
      gameRoll(socket, gameId);
    });

    // Mark the socket so we can identify the player.
    socket.userId = player.id;

    // Add this player to the list of currently playing players.
    lobbyPlayers[player.id] = player;

    // Send all the currently connected players to the user.
    sendAllPlayersToClient(socket);
    sendAllChallengesToClient(socket);
    sendAllGamesToPlayer(socket);

    // Let all the other users know that this user joined.
    socket.to('players').emit('lobby-players-join', {
      id: player.id,
      name: player.name
    });

    socket.leave('guests').join('players');
  }

  function setupGuest(socket) {

    socket.leave('players').join('guests');

    // Was this user logged in previously, or did they just join?
    if (socket.userId) {

      // Remove helper references.
      delete playerIdsToSocketIds[player.id];
      delete socketIdsToPlayerIds[socket.id];

      // This player is no longer in the lobby.
      delete lobbyPlayers[socket.userId];

      // Let everyone know they've left.
      var departingPlayer = getUserByProperty('id', socket.userId);
      socket.to('players').emit('lobby-players-left', {
        id: departingPlayer.id,
        name: departingPlayer.name
      });

      // Scrub the ID.
      socket.userId = null;
    }

    socket.on('login', authLogin);
    socket.on('register', authRegister);

    console.log(socket.id + ' authentication required');
    socket.emit('auth-required');
  }

  socket.on('game-move', function (details) {
    var gameState = gamesInProgress[details.gameId];

    if (gameState.state === 2) {
      // There is nothing we can do. The game is over now...
      return;
    }

    // Convert the track request back to an integer.
    details.track = parseInt(details.track);

    // Handy variables used in checks and updates.
    var currentPlayer = gameState.getCurrentPlayer();
    var currentEnemy = gameState.getEnemyPlayer();

    if (!gameState.isValidMove(details.track, details.lane)) {
      // Can't make this move.
      // Because the client should never present moves that aren't possible, if the
      // player has triggered this state then they're likely messing around in the
      // inspector. Force their client to update to a known good state.
      socket.emit('game-activity', gameState);

      // Nothing to do for now.
      return;
    }

    var destination = parseInt(details.track) + parseInt(gameState.currentRoll);

    // If we have reached the end then remove the token and increase the player score otherwise advance the token.
    if (destination === 15) {
      gameState.log(gameState.getCurrentPlayer().name + ' has got a token to the end!');
      currentPlayer.tokensDone += 1;
    } else {
      // Add the token to the new destination.
      gameState.track[destination] |= currentPlayer.number;
    }

    // Remove the token from its last position.
    gameState.track[details.track] ^= currentPlayer.number;

    // If we land on an enemy in the middle lane then they are knocked out.
    if (destination >= 5 && destination <= 12) {

      // If the cell we just landed on has an enemy inside of it...
      if ((gameState.track[destination] & currentEnemy.number) === currentEnemy.number) {

        // Remove them.
        gameState.track[destination] ^= currentEnemy.number;

        // Add the token back to their pile.
        currentEnemy.tokensWaiting += 1;
      }
    }

    // If we added a token to play then the token count decreases.
    if (details.track === 0) {
      currentPlayer.tokensWaiting -= 1;
    }

    // If we landed on a special square then we get another go.
    if ([4, 8, 14].indexOf(destination) >= 0) {
      gameState.log(gameState.getCurrentPlayer().name + ' landed on a special square and gets another go');

      // Reset the dice, we don't increment the turn counter if we get another go.
      // This way consecutive goes show under the same turn.
      gameState.currentRoll = null;
    } else {
      // Switch player.
      gameState.switchCurrentPlayer();

      // Reset the dice and increment the turn counter.
      gameState.nextTurn();
    }

    // Check to see if a player has won yet.
    if (currentPlayer.tokensDone === 7 || currentEnemy.tokensDone === 7) {
      // Game is over.
      gameState.state = 2;

      var winningPlayer = gameState.player1.tokensDone === 7 ? gameState.player1 : gameState.player2;

      gameState.log(winningPlayer.name + ' has won!');
      gameState.log('The game will be removed from your list shortly.');
      gameState.log('Thanks for playing!');

      setTimeout(function () {
        // In one minute destroy the game.
        delete gamesInProgress[gameState.id];

        // Tell the clients to remove the game from memory and the interface.
        player(gameState.player1.pid).emit('game-remove', gameState.id);
        player(gameState.player2.pid).emit('game-remove', gameState.id);
      }, 5000);
    }

    // Send a game update.
    player(gameState.player1.pid).emit('game-activity', gameState);
    player(gameState.player2.pid).emit('game-activity', gameState);
  });
});

function player(pid) {
  // Load details of the requested player.
  var player = getPlayerById(pid);

  if (!player) {
    throw new Error('Tried to load player id \'' + pid + '\' but it could not be found.');
  }

  var playerSocketId = playerIdsToSocketIds[pid];

  // If the player is offline then we aren't going to have their socket id.
  // In these cases we will send a stub socket back so that we don't have
  // to check in every place that the player sockets are used to see if
  // they actually are defined.
  if (!playerSocketId) {
    return {
      emit: function emit(event, payload) {
        console.log('emitting', event, 'to offline player', pid);
      },
      playerName: player.name
    };
  }

  // Return the actual socket for the player.
  return io.sockets.connected[playerSocketId];
}

/**
 * Start a game between two players.
 *
 * @param {PlayerModel} player1 Details of Player 1.
 * @param {PlayerModel} player2 Details of Player 2.
 */
function beginGame(player1, player2) {
  // We only allow one game between two unique players at a time.
  var gameId = [player1.id, player2.id].sort().join(':');

  if (gameId in gamesInProgress) {
    // Nothing to do.
    // The user would have been warned about a game in progress when creating the
    // challenge for the other player - they shouldn't reach this point.
    return;
  }

  var game = new Game(player1.id, player2.id);

  game.player1.name = player1.name;
  game.player2.name = player2.name;

  game.id = gameId;

  gamesInProgress[gameId] = game;

  var player1Roll = void 0,
      player2Roll = void 0;

  do {
    player1Roll = game.rollDice();
    player2Roll = game.rollDice();
  } while (player1Roll === player2Roll);

  game.player1.preGameRoll = player1Roll;
  game.player2.preGameRoll = player2Roll;

  game.log(player1.name + ' rolled a ' + player1Roll);
  game.log(player2.name + ' rolled a ' + player2Roll);

  if (player1Roll > player2Roll) {
    game.currentPlayer = game.player1.pid;
  } else {
    game.currentPlayer = game.player2.pid;
  }

  game.log(game.getCurrentPlayer().name + ' goes first!');

  // Increment after messages have been logged so pre-game messages show as
  // turn zero.
  game.turn += 1;
  game.state = 1;

  return game;
}

/**
 * Find a user record using the property and value.
 * If more than one exists, the first will be returned.
 *
 * @param {string} property The field to search.
 * @param {string|number} value The value to search for.
 * @returns {UserModel} The found user.
 */
function getUserByProperty(property, value) {
  for (var _i = 0; _i < usersCache.length; _i++) {
    if (usersCache[_i][property] === value) {
      return usersCache[_i];
    }
  }
  return null;
}

/**
 * Find a user record with the specified id.
 *
 * @param {number} id The id of the user to find.
 * @returns {UserModel} The found user.
 */
function getUserById(id) {
  return getUserByProperty('id', id);
}

/**
 * Find a player record using the property and value.
 * If more than one exists, the first will be returned.
 *
 * @param {string} property The field to search.
 * @param {string|number} value The value to search for.
 * @returns {PlayerModel}
 */
function getPlayerByProperty(property, value) {
  var user = getUserByProperty(property, value);

  if (!user) {
    throw new Error('Tried to getPlayerByProperty(' + property + ', ' + value + ') but it failed.');
  }

  // A user contains account details like hashed password and email address.
  // The player object will strip out sensitive details so that the user can
  // be sent to other clients.
  return {
    id: user.id,
    name: user.name
  };
}

/**
 * Find a player record with the specified id.
 *
 * @param {number} id The id of the player to find.
 * @returns {PlayerModel} The found player.
 */
function getPlayerById(id) {
  return getPlayerByProperty('id', id);
}

function sendAllPlayersToClient(socket) {
  console.log('sending connected players to', socket.id);
  var playerIds = Object.keys(lobbyPlayers);
  var players = [];
  for (var _i2 = 0; _i2 < playerIds.length; _i2++) {
    var playerId = playerIds[_i2];
    var _player = lobbyPlayers[playerId];

    players.push({
      id: _player.id,
      name: _player.name
    });
  }
  socket.emit('lobby-players-set', players);
}

function sendAllChallengesToClient(socket) {
  var challengeIds = Object.keys(challengeCache);
  var userChallenges = [];
  for (var _i3 = 0; _i3 < challengeIds.length; _i3++) {
    var challenge = challengeCache[challengeIds[_i3]];
    if (challenge.to === socket.userId) {
      var challenger = getUserById(challenge.from);
      userChallenges.push({
        challengerId: challenge.from,
        challengerName: challenger.name,
        challengeId: challenge.id
      });
    }
  }
  socket.emit('lobby-challenge-set', userChallenges);
}

function sendAllGamesToPlayer(socket) {
  var playerGames = [];

  var gameIds = Object.keys(gamesInProgress);

  for (var _i4 = 0; _i4 < gameIds.length; _i4++) {
    var game = gamesInProgress[gameIds[_i4]];

    if (game.player1.pid !== socket.userId && game.player2.pid !== socket.userId) {
      continue;
    }

    playerGames.push({
      gameId: game.id,
      turn: {
        number: game.turn,
        isYours: game.currentPlayer === socket.userId
      },
      currentPlayer: {
        id: game.getCurrentPlayer().pid,
        name: game.getCurrentPlayer().name
      },
      opponentName: game.getEnemyOfPlayerId(socket.userId).name
    });
  }

  // Send the list of games to the player.
  socket.emit('lobby-games-set', playerGames);
}

var challenges = {};

function challengePlayer(socket, playerId) {
  console.log('new challenge', socket.userId, 'is challenging', playerId);

  var challenger = getUserById(socket.userId);

  // Create a reference to uniquely identify this pair of users.
  var thisReference = [socket.userId, playerId].sort().join(':');

  if (thisReference in challengeCache) {
    // A challenge between these players is outstanding.

    // If the player being challenged already has an outstanding challenge
    // with the person challenging them, then accept the challenge.
    var existingChallenge = challengeCache[thisReference];
    if (existingChallenge.to === socket.userId) {
      // We're challenging the challenger - fight!
      challengeAccepted(existingChallenge.id);
    } else {
      // We're the one who sent the last challenge - nothing to do.
      var target = getPlayerById(playerId);
      socket.emit('lobby-challenge-exists', target.name);
      console.log('new challenge already exists');
      return;
    }
  }

  // Check that the players aren't already engaged in a game.
  if (thisReference in gamesInProgress) {
    // A game has been found.
    var _target = getPlayerById(playerId);
    socket.emit('lobby-game-exists', _target.name);
    return;
  }

  // todo: challenges expire after a while
  var newChallenge = {
    id: thisReference,
    from: socket.userId,
    to: playerId
  };

  challengeCache[newChallenge.id] = newChallenge;

  // Check to see if the player being challenged is currently online.
  if (playerId in playerIdsToSocketIds) {
    // The player appears to be online, we can send them a challenge event.
    var targetSocketId = playerIdsToSocketIds[playerId];
    socket.to(targetSocketId).emit('lobby-challenge-new', {
      challengerId: challenger.id,
      challengerName: challenger.name,
      challengeId: newChallenge.id
    });
    console.log('new challenge sent', targetSocketId);
  } else {
    console.log('new challenge player offline');
  }

  // If the player wasn't online, they should see the
  // challenge when they next log in.
}

function challengeAccepted(challengeId) {
  console.log('challenge accepted', challengeId);

  // Retrieve the challenge.
  var challenge = challengeCache[challengeId];

  var player1 = getPlayerById(challenge.from);
  var player2 = getPlayerById(challenge.to);

  // Remove the challenge as it is no longer needed.
  delete challengeCache[challengeId];

  var newGame = beginGame(player1, player2);

  if (!newGame) {
    // If the game already exists then beginGame doesn't return a game.
    // The user should never reach this state.
    return;
  }

  // Save the game to the cache.
  gamesInProgress[newGame.id] = newGame;

  // Notify the players that they have a new game.
  var newGamePayload = {
    gameId: newGame.id,
    turn: {
      number: newGame.turn,
      isYours: newGame.currentPlayer === player1.id
    },
    currentPlayer: {
      id: newGame.currentPlayer,
      name: newGame.getCurrentPlayer().name
    },
    opponentName: player2.name
  };

  player(player1.id).emit('lobby-games-add', newGamePayload);

  // Reconfigure for player 2.
  newGamePayload.turn.isYours = newGame.currentPlayer === player2.id;
  newGamePayload.opponentName = player1.name;

  player(player2.id).emit('lobby-games-add', newGamePayload);
}

function challengeRejected(challengeId) {
  console.log('challenge rejected', challengeId);
  // Remove the challenge.
  delete challengeCache[challengeId];
}

function gameSelect(socket, gameId) {
  console.log('game selected', gameId);
  var selectedGame = gamesInProgress[gameId];

  if (selectedGame) {
    console.log('game valid - sending');
    socket.emit('game-set', selectedGame);
  }
}

function gameRoll(socket, gameId) {
  console.log('game-roll', socket.userId, gameId);
  var game = gamesInProgress[gameId];

  if (game.currentPlayer !== socket.userId) {
    // Nothing to do.
    return;
  }

  if (game.currentRoll !== null) {
    // This player rolled already.
    return;
  }

  game.currentRoll = game.rollDice();
  game.log(game.getCurrentPlayer().name + ' rolled ' + game.currentRoll);

  if (game.currentRoll === 0) {
    // If the player rolled a zero then skip their turn, its back to the opponent to roll.
    game.log(game.getCurrentPlayer().name + ' misses a turn!');
    game.switchCurrentPlayer();
    game.nextTurn();
  } else if (!game.hasValidMoves()) {
    // Check if the player has any valid moves with this roll.
    game.log(game.getCurrentPlayer().name + ' has no valid moves');
    game.switchCurrentPlayer();
    game.nextTurn();
  }

  player(game.player1.pid).emit('game-activity', game);
  player(game.player2.pid).emit('game-activity', game);
}

/***/ }),
/* 1 */
/***/ (function(module, exports) {

module.exports = require("path");

/***/ }),
/* 2 */
/***/ (function(module, exports) {

module.exports = require("express");

/***/ }),
/* 3 */
/***/ (function(module, exports) {

module.exports = require("http");

/***/ }),
/* 4 */
/***/ (function(module, exports) {

module.exports = require("socket.io");

/***/ }),
/* 5 */
/***/ (function(module, exports) {

module.exports = require("fs");

/***/ }),
/* 6 */
/***/ (function(module, exports) {

module.exports = require("jsonwebtoken");

/***/ }),
/* 7 */
/***/ (function(module, exports) {

module.exports = require("crypto");

/***/ }),
/* 8 */
/***/ (function(module, exports) {

module.exports = require("node-cleanup");

/***/ }),
/* 9 */
/***/ (function(module, exports) {

module.exports = require("bcrypt");

/***/ }),
/* 10 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


var Player = __webpack_require__(11);

module.exports = Game;

/**
 * The Game object stores details about the state of the current game with supporting methods to help determine the
 * allowed moves.
 *
 * @param {string|number} pid1 The id of player 1.
 * @param {string|number} pid2 The id of player 2.
 * @constructor
 */
function Game(pid1, pid2) {

  /**
   * The data representing player 1.
   *
   * @type {Player} The player object.
   */
  this.player1 = new Player(pid1, 1);

  /**
   * The data representing player 2.
   *
   * @type {Player} The player object.
   */
  this.player2 = new Player(pid2, 2);

  /**
   * The id of the player whose turn it is.
   *
   * @type {?number} The id of the current player.
   */
  this.currentPlayer = null;

  /**
   * The value of the last dice roll.
   *
   * @type {?int} The value of the last dice roll or null if the roll hasn't happened yet.
   */
  this.currentRoll = null;

  /**
   * The id for this game.
   *
   * @type {?string} The identifier for this game or null if it hasn't been set yet.
   */
  this.id = null;

  /**
   * The number of turns played in this game.
   *
   * @type {int} The number of turns.
   */
  this.turn = 0;

  /**
   * A collection of messages generated by this game.
   *
   * @type {Array.<string>} The messages for this game.
   */
  this.messages = [];

  /**
   * The current game state.
   *
   * @type {int} 0: no state; 1: in progress; 2: finished.
   */
  this.state = 0;

  /**
   * The track stores the positions of players along the board.
   *
   * Note that bitwise operations are used to store the location of player 1 and player 2 in a single integer.
   * This is only for cells 1, 2, 3, 4, 13, and 14 where the cells can't knock each other off the track.
   *
   * @type {Object.<int, int>} The board state with player locations.
   */
  this.track = this.getTrack();
}

/**
 * Hydrate the Game object with the data provided.
 * Useful for reconstructing the game from an object.
 *
 * @param {Object} data An object containing game data.
 */
Game.prototype.hydrate = function (data) {
  var properties = Object.keys(this);

  for (var i = 0; i < properties.length; i++) {
    this[properties[i]] = data[properties[i]];
  }
};

/**
 * Get the value of a random dice roll - based on 4 coin flips.
 *
 * @returns {number} The value of the rolled dice.
 */
Game.prototype.rollDice = function () {

  // The number of movement points are decided by 4 coin flips.
  var dieValue = 0;

  for (var i in [1, 2, 3, 4]) {
    dieValue += Math.random() > 0.5;
  }

  return dieValue;
};

/**
 * Get a track object structured for easy comparison.
 *
 * @returns {Object.<int,int>} The pre-populated track.
 */
Game.prototype.getTrack = function () {

  var track = {};

  for (var i = 0; i <= 15; i++) {
    track[i] = 0;
  }

  return track;
};

/**
 * Checks whether a move is valid.
 *
 * @param {int} track The numerical index along the path that was selected.
 * @param {string} lane The name of the lane selected.
 * @returns {boolean} True if the move was valid; false otherwise.
 */
Game.prototype.isValidMove = function (track, lane) {

  if (lane === 'enemy') {
    // It doesn't matter what track piece was selected if it belongs in the enemy lane.
    return false;
  }

  return this.getValidMoves()[track];
};

/**
 * Calculate the valid moves that this player can make.
 *
 * @returns {Object.<number,boolean>} An object containing the track position and a bool for whether the move is valid.
 */
Game.prototype.getValidMoves = function () {

  var moves = {};

  if (this.currentRoll === null) {
    // A move cannot be made until we know the move count.
    return moves;
  }

  // First we need to know what valid moves there are for
  // the current player.
  var player = this.getCurrentPlayer();

  // Look along the track to see if there are any tokens
  // that can be moved with the current roll.
  for (var i = 0; i <= 14; i++) {

    // By default we can't move; we will change this value if we can move later.
    moves[i] = false;

    // If it is the starting cell then it is only valid if we have tokens and all the rules below apply.
    if (i === 0 && player.tokensWaiting === 0) {
      continue;
    }

    // Can't move from here if we don't have a token on this spot.
    // Doesn't apply to start tiles as they never actually have tokens.
    if ((this.track[i] & player.number) !== player.number && i !== 0) {
      continue;
    }

    // A token for this player was found - figure out if it can be moved to the destination.

    var destination = i + this.currentRoll;

    // Cannot move onto your own token.
    if ((this.track[destination] & player.number) === player.number) {
      continue;
    }

    // There is a token on the protected cell.
    if (destination === 8 && this.track[destination] > 0) {
      continue;
    }

    // We're near the end but don't have the exact roll to remove our token from the board.
    if (destination > 15) {
      continue;
    }

    // We can make this move.
    moves[i] = true;
  }

  return moves;
};

/**
 * Check to see if there are any valid moves for the current player.
 *
 * @returns {boolean} True if the current player has valid moves; false otherwise.
 */
Game.prototype.hasValidMoves = function () {

  // Collate all the booleans representing valid moves for each position on the track [true, false, false, true, etc].
  var validMovesBoolArray = Object.values(this.getValidMoves());

  // Sum all the booleans - a non-zero value indicates a number of valid moves.
  var numberOfValidMoves = validMovesBoolArray.reduce(function (boolean, sumOfBooleans) {
    return sumOfBooleans + boolean;
  }, 0);

  return numberOfValidMoves > 0;
};

/**
 * Get the current player's player object.
 *
 * @returns {Player} The player object for the current player.
 */
Game.prototype.getCurrentPlayer = function () {
  return this.currentPlayer === this.player1.pid ? this.player1 : this.player2;
};

/**
 * Get the enemy player's player object.
 *
 * @returns {Player} The player object for the enemy player.
 */
Game.prototype.getEnemyPlayer = function () {
  return this.currentPlayer === this.player1.pid ? this.player2 : this.player1;
};

/**
 * Get the player object for the provided player pid.
 *
 * @param {int} pid The player id of the player we want the player object for.
 * @returns {Player} The player object for the provided player id.
 */
Game.prototype.getPlayerById = function (pid) {
  return this.player1.pid === pid ? this.player1 : this.player2;
};

/**
 * Get the player object for the player number provided.
 *
 * @param {int} number The number of the player to get the player object for.
 * @returns {Player} The player object for the provided player number.
 */
Game.prototype.getPlayerByNumber = function (number) {
  return number === 1 ? this.player1 : this.player2;
};

/**
 * Get the enemy of the player id provided.
 *
 * @param {int} pid The id of the player to get the enemy of.
 * @returns {Player} The player object for the enemy of the pid.
 */
Game.prototype.getEnemyOfPlayerId = function (pid) {
  return this.currentPlayer === pid ? this.getEnemyPlayer() : this.getCurrentPlayer();
};

/**
 * Switch the current player.
 */
Game.prototype.switchCurrentPlayer = function () {
  this.currentPlayer = this.getEnemyPlayer().pid;
};

/**
 * Advance the game to the next turn.
 */
Game.prototype.nextTurn = function () {

  // Increment the turn counter.
  this.turn += 1;

  // Reset the dice.
  this.currentRoll = null;
};

/**
 * Add a message to the game log.
 *
 * @param {string|number} message The message to add to the game log.
 */
Game.prototype.log = function (message) {

  // Add the message to the game.
  this.messages.push({
    message: message,
    turn: this.turn
  });

  // Show the message in the console.
  console.log(message);
};

/***/ }),
/* 11 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


module.exports = Player;

/**
 * The Player object is used to track state about each of the players in the game.
 *
 * @param {int} pid The id of the player.
 * @param {int} playerNumber The number of the player.
 * @constructor
 */
function Player(pid, playerNumber) {

  /**
   * This player's number (either 1 for player 1 or 2 for player 2).
   *
   * @type {int} 1 or 2 for player 1 or 2.
   */
  this.number = playerNumber;

  /**
   * This player's id.
   *
   * @type {int} The id of the player.
   */
  this.pid = pid;

  /**
   * This player's name.
   *
   * @type {string} The name of the player.
   */
  this.name = 'Player';

  /**
   * The number of tokes that are waiting to enter play.
   *
   * @type {number} The number of tokens to be played.
   */
  this.tokensWaiting = 7;

  /**
   * The number of tokens that have passed around the board.
   *
   * @type {number} The number of tokens that have reached the end.
   */
  this.tokensDone = 0;
}

/***/ }),
/* 12 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


// Make a copy of this file and call it 'config.js' changing the properties below as required.
module.exports = {

    // The is the URL that the client will connect to. Append the port as required.
    SERVER: 'http://localhost:3000',

    // This is the port that the server will listen to connections on.
    PORT: 3000,

    // Developer mode.
    DEV: true
};

/***/ })
/******/ ]);