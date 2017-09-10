var express = require('express');
var app = express();
var server = require('http').Server(app);
var io = require('socket.io')(server);
var fs = require('fs');

// A quick and dirty to get files used on the client here
// where the server can use them too.
eval(fs.readFileSync('static/engine.js').toString());

// Serve the static content directly.
app.use(express.static(__dirname + '/static'));

app.get('/', function (req, res) {
    res.sendFile(__dirname + '/index.html');
});

server.listen(3000, function () {
    console.log('Listening on *:3000');
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

    socket.on('game-move', function (details) {
        var gameState = gamesInProgress[details.gameId];

        // Convert the track request back to an integer.
        details.track = parseInt(details.track);

        // Handy variables used in checks and updates.
        var currentPlayer = gameState.getCurrentPlayer();
        var currentEnemy = gameState.getEnemyPlayer();

        if (gameState.isValidMove(details.track, details.lane)) {
            var destination = parseInt(details.track) + parseInt(gameState.currentRoll);

            // Make the move.
            gameState.track[destination] |= currentPlayer.number;
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

            // Increment the turn counter.
            gameState.turn += 1;

            do {
                // Switch player (handle that we might have just rolled a zero).
                gameState.currentPlayer = (gameState.currentPlayer === currentPlayer.pid) ? currentEnemy.pid : currentPlayer.pid;

                // Roll dice.
                gameState.currentRoll = gameState.rollDice();

                console.log('new player', currentPlayer.pid, 'rolled', gameState.currentRoll);

            } while(gameState.currentRoll === 0);

            // Send a game update.
            player(gameState.player1.pid).emit('game-update', gameState);
            player(gameState.player2.pid).emit('game-update', gameState);
        } else {
            // Don't make the move.
            // TODO: Alert to the client that the move was bad.
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
    game.currentPlayer = (getRandomBoolean() ? socket1.id : socket2.id);

    do {
        game.currentRoll = game.rollDice();
    } while (game.currentRoll === 0);

    gamesInProgress[gameId] = game;

    socket1.emit('game-update', game);
    socket2.emit('game-update', game);
}
