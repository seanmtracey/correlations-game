const debug = require('debug')('bin:lib:game');
const uuid = require('uuid').v4;

const correlations_service = require('./correlations');

const runningGames = {};
const highScores = [];

/* 
Game class

UUID = uuid for this game
player = userUUID
state = What is the current state of play?
	- new - Game has not yet been started
	- current - game is in progress
	- finished - game has been completed
distance - the furthest distance achieved from the original (seed) person on the island
seedPerson - the person to start the game with. Initially undefined, but should be set on creation on game start.
*/

class Game{
	constructor(userUUID) {
		this.UUID = uuid();
		this.player = userUUID;
		this.state = 'new';
		this.distance = 0;
		this.seedPerson = undefined;
		this.nextAnswer = undefined;
		this.answersReturned = undefined;
	}

	selectRandomSeedPerson(){
		return correlations_service.allIslands()
			.then(islands => {
				const biggestIsland = islands[0];
				const topFive = Object.keys(biggestIsland).map(person => {
						return {
							name : person,
							numberOfConnectionsToOthers : biggestIsland[person]
						}
					})
					.sort( (a, b) => {
						if(a.numberOfConnectionsToOthers >= b.numberOfConnectionsToOthers){
							return -1
						} else {
							return 1;
						}
					})
					.slice(0, 5)
				;

				debug(topFive);

				return topFive[ Math.random() * 5 | 0 ];

			})
		;
	}

}

function createANewGame(userUUID){

	if(userUUID === undefined){
		return Promise.reject('No user UUID was passed to the function');
	}

	const newGame = new Game(userUUID);
	runningGames[newGame.UUID] = newGame;

	return newGame.selectRandomSeedPerson()
		.then(seedPerson => {
			newGame.seedPerson = seedPerson.name;
			debug(newGame);
			return newGame.UUID;
		})
	;

}

function getAQuestionToAnswer(gameUUID){

	if(gameUUID === undefined){
		return Promise.reject('No game UUID was passed to the function');
	} else if(runningGames[gameUUID] === undefined){
		return Promise.reject(`The game UUID '${gameUUID}' is not valid`);
	}

	return new Promise( (resolve, reject) => {

		const selectedGame = runningGames[gameUUID];
		debug(selectedGame);

		if(selectedGame.state === 'new'){
			selectedGame.state = 'current';
		}

		if(selectedGame.state === 'finished'){
			reject('GAMEOVER');
			return;
		}

		if(selectedGame.answersReturned !== undefined){
			resolve({
				seed : selectedGame.seedPerson,
				options : selectedGame.answersReturned
			});
		} else {

			correlations_service.calcChainLengthsFrom(selectedGame.seedPerson)
				.then(data => {
					debug(data);

					selectedGame.nextAnswer = data[1].entities[Math.random() * data[1].entities.length | 0];

					// Get the answer from the island 1 distance away, 
					// then get a wrong answer from the island 2 distance,
					// and then do the same 3 distance away.
					// Then randomise the order they're sent in.
					const possibleAnswers = [ 
						selectedGame.nextAnswer,
						data[2].entities[Math.random() * data[2].entities.length | 0],
						data[3].entities[Math.random() * data[3].entities.length | 0]
					].sort(function(){
						return Math.random() > 0.5 ? 1 : -1;
					});
					
					const answersToReturn = {
						a : possibleAnswers[0],
						b : possibleAnswers[1],
						c : possibleAnswers[2]
					};

					selectedGame.answersReturned = answersToReturn;

					resolve({
						seed : selectedGame.seedPerson,
						options : answersToReturn
					});
				})
			;

		}

	});

}

function answerAQuestion(gameUUID, submittedAnswer){

	if(gameUUID === undefined){
		return Promise.reject('No game UUID was passed to the function');
	} else if(runningGames[gameUUID] === undefined){
		return Promise.reject(`The game UUID '${gameUUID}' is not valid`);
	} else if(submittedAnswer === undefined){
		return Promise.reject(`An answer was not passed to the function`);
	}
	
	const selectedGame = runningGames[gameUUID];

	if(submittedAnswer === selectedGame.nextAnswer){
		selectedGame.distance += 1;
		selectedGame.seedPerson = submittedAnswer;
		selectedGame.answersReturned = undefined;
		return Promise.resolve(true);
	} else {
		selectedGame.state = 'finished';

		let scorePosition = -1;

		for(let x = 0; x < highScores.length; x += 1){

			if(selectedGame.distance > highScores[x].distance){
				scorePosition = x;
				break;
			}

		}

		if(scorePosition !== -1){
			highScores.splice(scorePosition, 0, selectedGame);

			if(highScores.length > 10){
				for(let y = highScores.length - 10; y > 0; y -= 1){
					highScores.pop();
				}
			}

		}

		return Promise.resolve(false);
	}

}

function getListOfHighScores(){

	return new Promise( (resolve) => {

		const sanitizedHighScores = highScores.map(score => {
			return {
				userUUID : score.userUUID,
				score : score.distance
			};
		});

		resolve(sanitizedHighScores);

	});

}

function checkIfAGameExistsForAGivenUUID(gameUUID){

	debug(`Checking gameUUID ${gameUUID}`);

	return new Promise( (resolve, reject) => {

		if(gameUUID === undefined){
			resolve(false);
		} else if(runningGames[gameUUID] === undefined){
			resolve(false);
		} else if(runningGames[gameUUID].state === 'finished'){
			resolve(false);
		} else {
			resolve(true);
		}

	});


}

module.exports = {
	new : createANewGame,
	question : getAQuestionToAnswer,
	answer : answerAQuestion,
	highScores : getListOfHighScores,
	check : checkIfAGameExistsForAGivenUUID
};