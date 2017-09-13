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

var Game = __webpack_require__(5);
var CONFIG = __webpack_require__(7);

console.log(__dirname);

// Serve the static content directly.
app.use(express.static(__dirname));

app.get('/', function (req, res) {
    res.sendFile(__dirname + '/index.html');
});

server.listen(CONFIG.PORT, function () {
    console.log('Listening on *:' + CONFIG.PORT);
});

var availablePlayers = {};

var gamesInProgress = {};

function serverTick() {

    // Ensure everyone knows who is available to play.
    sendAvailablePlayers();
}

function sendAvailablePlayers() {

    var clientFriendlyUserList = {};

    for (var p in availablePlayers) {
        var playerSocketId = availablePlayers[p].id;
        clientFriendlyUserList[playerSocketId] = availablePlayers[p].playerName || playerSocketId;
    }

    io.emit('connected-players', clientFriendlyUserList);
}

setInterval(serverTick, 1000);

io.on('connection', function (socket) {
    console.log(socket.id + ' has joined');

    // Store a reference to this player.
    availablePlayers[socket.id] = socket;

    // Default player name is the socket id.
    socket.playerName = socket.id;

    socket.on('name-change', function (name) {
        console.log(socket.id + ' has changed their name to ' + name);
        socket.playerName = name;
    });

    socket.on('challenge-player', function (playerId) {

        // Sanity check against curious people.
        if (socket.id === playerId) {
            // The player cannot challenge them self.
            return;
        }

        var opponentSocket = io.sockets.connected[playerId];

        console.log(socket.playerName + ' is challenging ' + opponentSocket.playerName);

        opponentSocket.emit('incoming-challenge', {
            playerId: socket.id,
            playerName: socket.playerName
        });
    });

    socket.on('challenge-accept', function (requesterId) {
        var requesterSocket = player(requesterId);
        console.log(socket.playerName + ' has accepted the challenge from ' + requesterSocket.playerName);
        requesterSocket.emit('challenge-accepted', {
            playerId: socket.id,
            playerName: socket.playerName
        });

        beginGame(requesterSocket, socket);
    });

    socket.on('challenge-reject', function (requesterId) {
        console.log(socket.playerName + ' has rejected the challenge from ' + io.sockets.connected[requesterId].playerName);
        player(requesterId).emit('challenge-rejected', {
            playerId: socket.id,
            playerName: socket.playerName
        });
    });

    socket.on('roll', function (gameId) {

        var currentGame = gamesInProgress[gameId];

        if (currentGame.currentPlayer !== socket.id) {
            // Not this players turn to roll yet.
            return;
        }

        if (currentGame.currentRoll !== null) {
            // This player rolled already.
            return;
        }

        currentGame.currentRoll = currentGame.rollDice();

        currentGame.log(socket.playerName + ' rolled ' + currentGame.currentRoll);

        if (currentGame.currentRoll === 0) {
            // If the player rolled a zero then skip their turn, its back to the opponent to roll.
            currentGame.log(socket.playerName + ' misses a turn!');
            currentGame.switchCurrentPlayer();
            currentGame.nextTurn();
        } else if (!currentGame.hasValidMoves()) {
            // Check if the player has any valid moves with this roll.
            currentGame.log(socket.playerName + ' has no valid moves');
            currentGame.switchCurrentPlayer();
            currentGame.nextTurn();
        }

        player(currentGame.player1.pid).emit('game-update', currentGame);
        player(currentGame.player2.pid).emit('game-update', currentGame);
    });

    socket.on('game-move', function (details) {
        var gameState = gamesInProgress[details.gameId];

        // Convert the track request back to an integer.
        details.track = parseInt(details.track);

        // Handy variables used in checks and updates.
        var currentPlayer = gameState.getCurrentPlayer();
        var currentEnemy = gameState.getEnemyPlayer();

        if (!gameState.isValidMove(details.track, details.lane)) {
            // Can't make this move.
            return;
        }

        var destination = parseInt(details.track) + parseInt(gameState.currentRoll);

        // If we have reached the end then remove the token and increase the player score otherwise advance the token.
        if (destination === 15) {
            gameState.log(socket.playerName + ' has got a token to the end!');
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
            gameState.log(socket.playerName + ' landed on a special square and gets another go');
        } else {
            // Switch player.
            gameState.switchCurrentPlayer();
        }

        // Reset the dice and increment the turn counter.
        gameState.nextTurn();

        // Check to see if a player has won yet.
        if (currentPlayer.tokensDone === 7 || currentEnemy.tokensDone === 7) {
            // Game is over.
            gameState.state = 2;
            player(gameState.player1.pid).emit('game-done', gameState);
            player(gameState.player2.pid).emit('game-done', gameState);
        } else {
            // Game is still going...
            // Send a game update.
            player(gameState.player1.pid).emit('game-update', gameState);
            player(gameState.player2.pid).emit('game-update', gameState);
        }
    });

    socket.on('disconnect', function () {
        console.log(socket.id + ' has left');
        // Remove a reference to this player.
        delete availablePlayers[socket.id];
    });
});

function player(pid) {
    return io.sockets.connected[pid];
}

function beginGame(socket1, socket2) {
    var gameId = socket1.id + ':' + socket2.id;
    var game = new Game(socket1.id, socket2.id);

    game.id = gameId;
    game.turn += 1;

    gamesInProgress[gameId] = game;

    var player1Roll = void 0,
        player2Roll = void 0;

    do {
        player1Roll = game.rollDice();
        player2Roll = game.rollDice();
    } while (player1Roll === player2Roll);

    game.player1.preGameRoll = player1Roll;
    game.player2.preGameRoll = player2Roll;

    game.log(socket1.playerName + ' rolled a ' + player1Roll);
    game.log(socket2.playerName + ' rolled a ' + player2Roll);

    if (player1Roll > player2Roll) {
        game.currentPlayer = game.player1.pid;
    } else {
        game.currentPlayer = game.player2.pid;
    }

    game.log(player(game.currentPlayer).playerName + ' goes first!');

    game.state = 1;

    socket1.emit('game-update', game);
    socket2.emit('game-update', game);
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
/***/ (function(module, exports, __webpack_require__) {

"use strict";


var Player = __webpack_require__(6);

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
     * @type {string} The id of the current player.
     */
    this.currentPlayer = null;

    /**
     * The value of the last dice roll.
     *
     * @type {int|null} The value of the last dice roll or null if the roll hasn't happened yet.
     */
    this.currentRoll = null;

    /**
     * The id for this game.
     *
     * @type {string|null} The identifier for this game or null if it hasn't been set yet.
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
    this.messages.push(message);

    // Show the message in the console.
    console.log(message);
};

/***/ }),
/* 6 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


module.exports = Player;

/**
 * The Player object is used to track state about each of the players in the game.
 *
 * @param {string} pid The id of the player.
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
   * @type {string} The id of the player.
   */
  this.pid = pid;

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
};

/***/ }),
/* 7 */
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