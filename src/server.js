const path = require('path');
const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server, { serveClient: false });

const Game = require('./js/Game');
const CONFIG = require('./js/config');

console.log(__dirname);

// Serve the static content directly.
app.use(express.static(__dirname));

app.get('/', function (req, res) {
    res.sendFile(__dirname + '/index.html');
});

server.listen(CONFIG.PORT, () => {
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
        })

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
        const gameState = gamesInProgress[details.gameId];

        // Convert the track request back to an integer.
        details.track = parseInt(details.track);

        // Handy variables used in checks and updates.
        const currentPlayer = gameState.getCurrentPlayer();
        const currentEnemy = gameState.getEnemyPlayer();

        if (!gameState.isValidMove(details.track, details.lane)) {
            // Can't make this move.
            return;
        }

        const destination = parseInt(details.track) + parseInt(gameState.currentRoll);

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
    const gameId = socket1.id + ':' + socket2.id;
    const game = new Game(socket1.id, socket2.id);

    game.id = gameId;
    game.turn += 1;

    gamesInProgress[gameId] = game;

    let player1Roll, player2Roll;

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
