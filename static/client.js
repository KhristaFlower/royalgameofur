// Create a placeholder game object.
var currentGameState = new Game(1, 2);

var socket = io(CONFIG.SERVER);

socket.on('refresh', function () {
    window.location = window.location;
});

socket.on('connected-players', function (players) {
    // Render a list of all currently connected players.
    var playerList = document.getElementById('connected-players-list');
    playerList.innerHTML = '';

    for (var p in players) {
        if (!players.hasOwnProperty(p)) {
            continue;
        }

        if (p === socket.id) {
            // Don't display our own name.
            continue;
        }

        var playerName = document.createElement('button');
        playerName.addEventListener('click', challengePlayer);
        playerName.setAttribute('data-player-id', p);
        playerName.innerText = players[p];
        playerList.appendChild(playerName);
    }
});

socket.on('incoming-challenge', function (details) {
    console.log('You have been challenged by ' + details.playerName);
    if (CONFIG.DEV || confirm('You are challenged by ' + details.playerName + '. Do you accept?')) {
        console.log('You have accepted the challenge from ' + details.playerName);
        socket.emit('challenge-accept', details.playerId);
    } else {
        console.log('You have rejected the challenge from ' + details.playerName);
        socket.emit('challenge-reject', details.playerId);
    }
});

socket.on('challenge-accepted', function (details) {
    console.log(details.playerName + ' has accepted your challenge!');
});

socket.on('challenge-rejected', function (details) {
    console.log(details.playerName + ' has rejected your challenge!');
});

socket.on('game-update', function (game) {

    document.querySelector('.play-area').classList.remove('hidden');

    console.log('game-update', game);

    // Create a fresh game state.
    currentGameState = new Game(1, 2);

    // Copy the server state onto the client state.
    var gameProperties = ['id', 'turn', 'track', 'state', 'player1', 'player2', 'currentRoll', 'currentPlayer'];

    for (var p = 0; p < gameProperties.length; p++) {
        currentGameState[gameProperties[p]] = game[gameProperties[p]];
    }

    // Update the GUI elements to reflect the new game state.
    if (socket.id === currentGameState.currentPlayer) {
        document.getElementById('whoseTurn').innerText = 'Your turn! (' + currentGameState.turn + ')';
        if (currentGameState.currentRoll !== null) {
            document.getElementById('currentRoll').innerText = 'You rolled a ' + currentGameState.currentRoll + '!';
        } else {
            document.getElementById('currentRoll').innerText = 'Roll the dice!';
        }
    } else {
        document.getElementById('whoseTurn').innerText = 'Opponents turn. (' + currentGameState.turn + ')';
        if (currentGameState.currentRoll !== null) {
            document.getElementById('currentRoll').innerText = 'Your opponent rolled a ' + currentGameState.currentRoll;
        } else {
            document.getElementById('currentRoll').innerText = 'Waiting for your opponent to roll.';
        }
    }

    var player = currentGameState.getPlayerById(socket.id);
    var enemy = currentGameState.getPlayerByNumber(player.number === 1 ? 2 : 1);

    document.getElementById('playerTokensWaiting').innerText = 'Your tokens waiting: ' + player.tokensWaiting;
    document.getElementById('enemyTokensWaiting').innerText = 'Enemy tokens waiting: ' + enemy.tokensWaiting;

    // Clear any currently valid cells.
    var validCells = document.querySelectorAll('.input .cell.valid');
    for (var vc = 0; vc < validCells.length; vc++) {
        validCells[vc].classList.remove('valid');
    }

    // Don't show any moves until the dice roll is known.
    if (currentGameState.currentRoll !== null) {

        // Mark any of the cells that are valid moves.
        if (socket.id === currentGameState.currentPlayer) {
            console.log('We are the current player');
            // Show the valid moves that the player can make.
            var validMoves = currentGameState.getValidMoves();

            for (var i = 0; i <= 14; i++) {
                var lane = (i <= 4 || i >= 13) ? 'player' : 'middle';
                var cell = document.querySelector('.cell[data-lane="' + lane + '"][data-track="' + i + '"]');
                if (validMoves[i] === true) {
                    cell.classList.add('valid');
                }
            }
        }
    }

    // Remove all the current tokens on the board.
    var existingTokens = document.querySelectorAll('.cell.token-player, .cell.token-enemy');
    for (var et = 0; et < existingTokens.length; et++) {
        existingTokens[et].classList.remove('token-player', 'token-enemy');
    }

    // Add the tokens to the board.
    for (var t = 1; t <= 14; t++) {
        var trackValue = currentGameState.track[t];

        if (trackValue === 0) {
            // No tokens on this cell.
            continue;
        }

        if ((trackValue & player.number) === player.number) {
            getBoardCell(t, 'player').classList.add('token-player');
        }

        if ((trackValue & enemy.number) === enemy.number) {
            getBoardCell(t, 'enemy').classList.add('token-enemy');
        }
    }

    // Show or hide the dice box depending on whether you can roll or not.
    var diceBox = document.querySelector('.dice-box');

    console.log(currentGameState.currentPlayer, socket.id);
    if (currentGameState.currentPlayer === socket.id) {
        diceBox.classList.remove('hidden');
        if (currentGameState.currentRoll === null) {
            diceBox.innerText = 'Roll';
        } else {
            diceBox.innerText = currentGameState.currentRoll;
        }
    } else {
        diceBox.classList.add('hidden');
    }

    // Display the last 10 game messages.
    var reverseMessages = game.messages.reverse().splice(0, 10);
    if (game.messages.length > 10) {
        reverseMessages.push('(+' + (game.messages.length - 10) + ' messages)');
    }

    var messageArea = document.querySelector('.message-area');
    messageArea.innerHTML = '';

    for (var m = 0; m < reverseMessages.length; m++) {
        var messageElement = document.createElement('div');
        messageElement.innerText = reverseMessages[m];
        messageArea.appendChild(messageElement);
    }

    // Hide some UI elements if the game is in progress.
    if (parseInt(currentGameState.state) === 1) {
        // Game in progress.
        document.querySelector('.challenge-area').classList.add('hidden');
    } else {
        document.querySelector('.challenge-area').classList.remove('hidden');
    }
});

function getBoardCell(track, lane) {
    // Force the middle lane if the track number exists there.
    if (track >= 5 && track <= 12) {
        lane = 'middle';
    }

    return document.querySelector('.board .cell[data-lane="' + lane + '"][data-track="' + track + '"]');
}

function challengePlayer() {
    var playerId = this.getAttribute('data-player-id');
    socket.emit('challenge-player', playerId);
    return false;
}

window.addEventListener('load', function () {

    if (localStorage.getItem('player-name')) {
        socket.emit('name-change', localStorage.getItem('player-name'));
    }

    document
        .getElementById('updatePlayerName')
        .addEventListener('click', function () {
            var name = document.getElementById('playerName').value;
            if (name) {
                console.log('Player is changing their name to', name);
                localStorage.setItem('player-name', name);
                socket.emit('name-change', name);
            }
        });

    document
        .querySelector('.dice-box')
        .addEventListener('click', function () {
            console.log('Attempting to roll the dice!');
            socket.emit('roll', currentGameState.id);
        });

    var inputCells = document.querySelectorAll('div#game div.input div.cell');

    for (var i = 0; i < inputCells.length; i++) {
        var inputCell = inputCells[i];

        inputCell.addEventListener('click', function () {

            if (currentGameState.turn === 0) {
                // No game to play yet.
                return;
            }

            var lane = this.getAttribute('data-lane');
            var track = this.getAttribute('data-track');

            if (track === 'player') {
                // No need to click on the other player's cells.
                return;
            }

            if (currentGameState.isValidMove(track, lane)) {
                socket.emit('game-move', {
                    gameId: currentGameState.id,
                    track: track,
                    lane: lane
                })
            }

            console.log('Selected', track, 'on', lane, this);
        });
    }
});
