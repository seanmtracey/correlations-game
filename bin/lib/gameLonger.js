const debug = require('debug')('bin:lib:gameLonger');
const uuid = require('uuid').v4;

// const database = require('./database');
const database = (process.env.DATABASE === 'PRETEND')? require('./database_pretend') : require('./database');
const correlations_service = require('./correlations');
const barnier = require('./barnier-filter'); // Filter names from the game that we know to not work - like Michel Barnier

const databaseTable = process.env.GAME_TABLE;

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
nextAnswer - the correct answer for the seed person given. Also the next seed person is question is answered correctly
answersReturned - if the question has been requested more than once, the original set of answers (stored in this variable) will be returned instead of generating new ones for the seed person
blacklist - each seed person is added to this list so they cannot be the seed person in future questions
remainingCandidatesWithConnections - a whitelist of people who could be chosen as seeds
intervalDays - how many days of articles are covered by the current correlations_service
history - record the sequence of questionData items for a summary at the end of a game
achievedHighestScore, achievedHighestScoreFirst - set when finishing a question, based on current best score
*/
const GAMES_STATS_ID = 'UUID_FOR_GAMES_STATS';

let GAMES_STATS = {
	counts      : { created : 0, finished : 0, cloned: 0 },
	scoreCounts : { 0 : 0 }, // { score : count } - prime it with a count of 0 so there is always a counted score
	maxScore    : 0,
	uuid        : GAMES_STATS_ID,
}

const GAME_VARIANT = {
	any_seed                : 'any_seed',
	any_seed_kill_answer    : 'any_seed_kill_answer',
	seed_from_answer        : 'seed_from_answer',
	seed_from_answer_or_any : 'seed_from_answer_or_any',
	default                 : 'any_seed_kill_answer',
}

if(process.env.GAME_VARIANT !== undefined){
	if (GAME_VARIANT.hasOwnProperty(process.env.GAME_VARIANT)) {
		GAME_VARIANT.default = GAME_VARIANT[process.env.GAME_VARIANT];
	} else {
		debug(`WARNING: unrecognised value of process.env.GAME_VARIANT, {process.env.GAME_VARIANT}: should be one of ${JSON.stringify(Object.keys(GAME_VARIANT))}`);
	}
}

const MAX_CANDIDATES = parseInt( (process.env.MAX_CANDIDATES === undefined)? -1 : process.env.MAX_CANDIDATES );

class Game{
	constructor(userUUID, config=undefined) {
		this.uuid     = userUUID;
		this.player   = userUUID;

		// context of current game
		this.state     = 'new';
		this.distance  = 0;
		this.blacklist = []; // will hold all non-available candidates, including chosen seeds, barnier, dead-ends, etc, also populated in createAnNewGame
		this.remainingCandidatesWithConnections = []; // to be populated in createANewGame
		this.remainingCandidatesByName = {}; // to be populated in createANewGame
		this.history   = [];
		this.variant   = GAME_VARIANT.default;
		this.max_candidates = MAX_CANDIDATES;
		this.firstFewMax = parseInt( (process.env.FIRST_FEW_MAX === undefined)? 5 : process.env.FIRST_FEW_MAX );

		// details+context of the current question
		this.seedPerson          = undefined;
		this.nextAnswer          = undefined;
		this.answersReturned     = undefined;
		this.linkingArticles     = undefined;
		this.intervalDays        = undefined;
		this.achievedHighestScore      = undefined;
		this.achievedHighestScoreFirst = undefined;
		this.isQuestionSet       = false;

		// pre-pop the blacklist with the barnier list
		barnier.list().forEach(uuid => {this.addToBlacklist(uuid);});

		const missing_fields = [];

    // handle when we are re-building a Game instance from a simple obj (e.g. from the DB)
		if( config !== undefined ) {
			if (userUUID !== config['uuid']) {
				throw `Game.constructor: config defined, but mistmatched uuids: userUUID=${userUUID}, config.uuid=${config.uuid}, config=${JSON.stringify(config)}`;
			}
			[
				'uuid', 'player', 'state', 'distance', 'blacklist',
				'remainingCandidatesWithConnections', 'remainingCandidatesByName',
				'history', 'isQuestionSet',
				'variant', 'max_candidates', 'firstFewMax'
			].forEach( field => {
				if (!config.hasOwnProperty(field)) {
					debug(`Game.constructor: config missing field=${field}: config=${JSON.stringify(config)}`);
					missing_fields.push(field);
				}
				this[field] = config[field];
			});
			[
				'seedPerson', 'nextAnswer', 'answersReturned', 'linkingArticles', 'intervalDays',
			].forEach( field => {
				if (this.isQuestionSet && !config.hasOwnProperty(field)) {
					debug(`Game.constructor: config.isQuestionSet===true but field=${field} not defined: config=${JSON.stringify(config)}`);
					missing_fields.push(field);
				}
				this[field] = config[field];
			});

			if (missing_fields.length > 0) {
				this.missing_fields = missing_fields; // setting this field signifies that the config source is out of date (from a prev version of code) and has created a corrupt game instance
				debug(`WARNING: Game.constructor: this.missing_fields = ${JSON.stringify(missing_fields)}`);
			}
		}
	}

	addToBlacklist(name) {
		debug(`addToBlacklist: name=${name}`);
		return this.blacklist.push( name.toLowerCase() );
	};
	isBlacklisted(name) { return this.blacklist.indexOf( name.toLowerCase() ) > -1; };
	filterOutBlacklisted(names) { return names.filter( name => {return !this.isBlacklisted(name);}) };
	isCandidate(name) { return this.remainingCandidatesByName.hasOwnProperty( name ); };
	filterCandidates(names) { return names.filter( name => {return this.isCandidate(name);}) };

	addCandidates( candidates ) {
		let count = 0;
		candidates.forEach( cand => {
			if (this.max_candidates >= 0 && this.max_candidates === count) {
				return;
			}
			const candName = cand[0];

			if (candName.match(/[^:a-zA-Z ]/) !== null ) { // just ignore any names containing non-letters (apart from colon and spaces)
				this.addToBlacklist(candName);
			}

			if (! this.isBlacklisted(candName)) {
				this.remainingCandidatesWithConnections.push(cand);
				this.remainingCandidatesByName[candName] = cand;
				count = count + 1;
			}
		});
		debug(`Game.addCandidates: added ${count}, all candidates=${Object.keys(this.remainingCandidatesByName)}`);
	}

	blacklistCandidate(name){
		let candIndex = -1; // locate candidate in list
		this.remainingCandidatesWithConnections.some( (cand, i) => {
			if (cand[0] === name) {
				candIndex = i;
				return true;
			} else {
				return false;
			}
		} );

		if (candIndex >= 0) {
			this.remainingCandidatesWithConnections.splice(candIndex, 1)
			delete this.remainingCandidatesByName[name];
		}

		this.addToBlacklist( name );
		debug(`Game.blacklistCandidate: name=${name}`);
	}

	pickFromFirstFew(items, max=this.firstFewMax){
		if (items.length === 0) {
			debug(`Game.pickFromFirstFew: items.length === 0`);
			return undefined;
		}
		const range = Math.min(max, items.length);
		const index = Math.floor(Math.random()*range);
		const item  = items[index];
		debug(`Game.pickFromFirstFew: items.length=${items.length}, range=${range}, index=${index}, item=${item}`);
		return item;
	}

	pickNameFromTopFewCandidates(max=5){
		if(this.remainingCandidatesWithConnections.length < 4) {
			return undefined; // must have at least 4 people left: seed + 3 answers
		}
		const candidate = this.pickFromFirstFew( this.remainingCandidatesWithConnections );
		debug(`Game.pickNameFromTopFewCandidates: candidate=${candidate}`);
		return (candidate === undefined)? undefined : candidate[0];
	}

	clearQuestion(){
		this.seedPerson      = undefined;
		this.answersReturned = undefined;
		this.nextAnswer      = undefined;
		this.linkingArticles = undefined;
		this.achievedHighestScore      = undefined;
		this.achievedHighestScoreFirst = undefined;
		this.isQuestionSet   = false;
	}

	shuffle(arr) {
	    let i, j, temp;
	    for (i = arr.length - 1; i > 0; i--) {
	        j = Math.floor(Math.random() * (i + 1));
	        temp = arr[i];
	        arr[i] = arr[j];
	        arr[j] = temp;
	    }
	    return arr;
	}

	// involves a recursive use of Promises. Oooh. Not sure if that is A Bad Thing.
	// Basic alg:
	// - start with a list of candidates, sorted by num connections (highest first)
	// - pick one of the first few as a potential seedPerson
	//   - get the chainLengths info from the service for that seedPerson
	//   - check we have enough links in the chain (need at least 4)
	//   - pick a nextAnswer from the 2nd link in the chain
	//   - pick a wrongAnswer from the 3rd link
	//   - pick a wrongAnswer from the 4th link
	//   - get the linkingArticles between seedPerson and the nextAnswer
	//   - construct and return the question data structure
	// - if any of the steps after picking a potential seedPerson fails
	//   - blacklist the seedPerson
	//   - recursively call this fn again (to try another seedPerson)
	// - if we run out of candidates, return undefined

	promiseNextCandidateQuestion(){
		debug(`promiseNextCandidateQuestion: start`);
		let question = {
			seedPerson     : undefined,
			nextAnswer     : undefined,
			wrongAnswers   : [],
			answersReturned: undefined,
			linkingArticles: undefined,
		};

		let seedPerson = undefined;
		if(
				 this.variant === GAME_VARIANT.any_seed
			|| this.variant === GAME_VARIANT.any_seed_kill_answer
		){
				seedPerson = this.pickNameFromTopFewCandidates();
		} else if(
				 this.variant === GAME_VARIANT.seed_from_answer
			|| this.variant === GAME_VARIANT.seed_from_answer_or_any
		) {
			if (this.history.length > 0) {
				seedPerson = this.history[this.history.length-1].nextAnswer;
				if (this.isBlacklisted(seedPerson)) {
					if (this.variant === GAME_VARIANT.seed_from_answer_or_any) {
						seedPerson = this.pickNameFromTopFewCandidates();
					} else {
						seedPerson = undefined;
					}
				}
			} else {
				seedPerson = this.pickNameFromTopFewCandidates();
			}
		} else {
				throw `ERROR: invalid GAME_VARIANT: this.variant=${this.variant}: should be one of ${JSON.stringify(Object.keys(GAME_VARIANT))}`;
		}

		return Promise.resolve( seedPerson )
		.then( name => {
			if (name === undefined) { return undefined; }
			question.seedPerson = name;

			return correlations_service.calcChainLengthsFrom(name)
			.then(chainLengths => {
				if (chainLengths.length < 4) {
					debug(`promiseNextCandidateQuestion: reject name=${name}: chainLengths.length(${chainLengths.length}) < 4`);
					this.blacklistCandidate(question.seedPerson);
					return this.promiseNextCandidateQuestion();
				}
				const nextAnswers = this.filterCandidates( chainLengths[1].entities );
				if (nextAnswers.length === 0) {
					debug(`promiseNextCandidateQuestion: reject name=${name}: nextAnswers.length === 0`);
					this.blacklistCandidate(question.seedPerson);
					return this.promiseNextCandidateQuestion();
				}
				question.nextAnswer = this.pickFromFirstFew( nextAnswers );
				const wrongAnswers1 = this.filterCandidates( chainLengths[2].entities );
				if (wrongAnswers1.length === 0) {
					debug(`promiseNextCandidateQuestion: reject name=${name}: wrongAnswers1.length === 0`);
					this.blacklistCandidate(question.seedPerson);
					return this.promiseNextCandidateQuestion();
				}
				question.wrongAnswers.push( this.pickFromFirstFew( wrongAnswers1 ) );
				const wrongAnswers2 = this.filterCandidates( chainLengths[3].entities );
				if (wrongAnswers2.length === 0) {
					debug(`promiseNextCandidateQuestion: reject name=${name}: wrongAnswers2.length === 0`);
					this.blacklistCandidate(question.seedPerson);
					return this.promiseNextCandidateQuestion();
				}
				question.wrongAnswers.push( this.pickFromFirstFew( wrongAnswers2 ) );
				// yay, means we have all the bits needed for a valid question
				question.answersReturned = question.wrongAnswers.slice(0);
				question.answersReturned.push(question.nextAnswer);
				this.shuffle( question.answersReturned );
				return correlations_service.calcChainWithArticlesBetween(question.seedPerson, question.nextAnswer)
				.then( data => {
					question.linkingArticles = data.articlesPerLink[0];
					return question;
				})
				.catch(err => {
					debug(`promiseNextCandidateQuestion: Unable to fetch articles between ${question.seedPerson} and ${question.nextAnswer}`, err);
					throw err;
				})
				;
			})
			;
		})
		;
	}

	acceptQuestionData(qd){
		this.history.push(qd);

		this.seedPerson      = qd.seedPerson;
		this.answersReturned = qd.answersReturned;
		this.nextAnswer      = qd.nextAnswer;
		this.linkingArticles = qd.linkingArticles;

		this.blacklistCandidate(this.seedPerson);

		if (this.variant === GAME_VARIANT.any_seed_kill_answer) {
			this.blacklistCandidate(this.nextAnswer);
		}

		this.isQuestionSet   = true;

		debug(`Game.acceptQuestionData: seedPerson=${qd.seedPerson}, num remainingCandidatesWithConnections=${this.remainingCandidatesWithConnections.length}`);
	}

	finish(){
		this.state = 'finished';
		return this.updateScoreStats();
	}

	updateScoreStats() {
		const score = this.distance;
		return Game.updateGamesStats( stats => {
			GAMES_STATS.counts.finished += 1;

			if (! GAMES_STATS.scoreCounts.hasOwnProperty(score)) {
				GAMES_STATS.scoreCounts[score] = 0;
			}
			GAMES_STATS.scoreCounts[score] += 1;
			GAMES_STATS.maxScore = Math.max(GAMES_STATS.maxScore, score);
		})
		.then( () => {
			this.achievedHighestScore      = (score>0 && score === GAMES_STATS.maxScore);
			this.achievedHighestScoreFirst = (this.achievedHighestScore && GAMES_STATS.scoreCounts[score]===1);
		})
		;
	}

	updateClonedCount() {
		return Game.updateGamesStats( stats => { stats.counts.cloned += 1;} );
	}
	updateCreatedCount() {
		return Game.updateGamesStats( stats => { stats.counts.created += 1;} );
	}

	static readFromDB( uuid ){
		return database.read({ uuid : uuid }, process.env.GAME_TABLE)
		.then( data => {
			if (data.Item === undefined) {
				return undefined;
			} else if (uuid === GAMES_STATS_ID) {
				return data.Item;
			} else {
				let clonedGame = undefined;
				try {
					clonedGame = new Game(data.Item.uuid, data.Item);
				} catch( err ) {
					debug(`ERROR: readFromDB: cloning game failed: err=${err}`);
					clonedGame = undefined;
				}

				if (clonedGame === undefined) {
					return undefined;
				} else if (clonedGame.hasOwnProperty('missing_fields')) {
					debug(`WARNING: readFromDB: missing_fields ==> corrupt data.Item retrieved from db, so returning undefined to trigger starting a new game`);
					return undefined;
				} else {
					return clonedGame.updateClonedCount()
					.then( () => { return clonedGame; } )
					;
				}
			}
		})
		;
	}

	static writeToDB( objWithUuid ) {
		return new Promise( (resolve, reject) => {
			if (! objWithUuid.hasOwnProperty('uuid')) {
				reject( `Game.writeToDB must be passed an obj with a uuid field, objWithUuid=${JSON.stringify(objWithUuid)}` );
			} else {
				database.write(objWithUuid, process.env.GAME_TABLE)
				.then( () => { resolve(); })
				;
			}
		})
		;
	}

	static updateGamesStats( fn ){
		return database.read({uuid: GAMES_STATS_ID}, process.env.GAME_TABLE)
		.then( data  => { return (data !== undefined) ? data.Item : undefined; })
		.then( stats => { if (stats !== undefined) { GAMES_STATS = stats; } } )
		.then( ()    => {
			debug(`updateGamesStats: invoking update fn`);
			fn(GAMES_STATS);
		})
		.then( ()    => { database.write(GAMES_STATS, process.env.GAME_TABLE) } )
		.then( ()    => { debug(`updateGamesStats: eof`); })
		.catch( err => {
			debug `ERROR: Game.updateGamesStats: err=${err}`;
			throw err;
		})
	}

} // eof Class Game


function createANewGame(userUUID){

	if(userUUID === undefined){
		return Promise.reject('No user UUID was passed to the function');
	}

	const newGame = new Game(userUUID);
	debug(`createANewGame: newGame=${JSON.stringify(newGame)}`);

	return newGame.updateCreatedCount()
		.then( () => { return correlations_service.biggestIsland(); } )
		.then(island => {	newGame.addCandidates(island) })
		.then( () => { return correlations_service.summary() } )
		.then( summary => {
			debug(`createANewGame: summary=${JSON.stringify(summary)}`);
			newGame.intervalDays = Math.floor( summary.times.intervalCoveredHrs / 24 )
		} )
		.then(function(){
			return Game.writeToDB(newGame)
				.then(function(){
					return newGame.uuid;
				})
				.catch(err => {
					debug('createANewGame: Unable to store game instance in database:', err);
					throw err;
				})
			;
		})
	;
}

function getAQuestionToAnswer(gameUUID){

	debug(`getAQuestionToAnswer: gameUUID=${gameUUID}`);

	if(gameUUID === undefined){
		return Promise.reject('No game UUID was passed to the function');
	}

	return Game.readFromDB(gameUUID)
	.then(selectedGame => {
		if(selectedGame === undefined){
			throw `The game UUID '${gameUUID}' is not valid`;
		}

		debug(`getAQuestionToAnswer: selectedGame=${JSON.stringify(selectedGame)}`);

		if(selectedGame.state === 'new'){ // keep asking the same question
			selectedGame.state = 'current';
		}

		if(selectedGame.state === 'finished'){
			throw('GAMEOVER');
		}

		if(selectedGame.isQuestionSet){
			return {
				seed : selectedGame.seedPerson,
				options : selectedGame.answersReturned,
				intervalDays : selectedGame.intervalDays,
				questionNum : selectedGame.distance + 1,
				globalHighestScore : GAMES_STATS.maxScore,
			};
		} else {
				// if we are here, we need to pick our seed, nextAnswer, answersReturned
			return selectedGame.promiseNextCandidateQuestion()
			.catch( err => {
				debug(`ERROR: getAQuestionToAnswer: err=${JSON.stringify(err)}`);
				throw err;
			})
			.then(questionData => {
				debug(`getAQuestionToAnswer: questionData=${JSON.stringify(questionData, null, 2)}`);

				if(questionData === undefined){
					debug(`getAQuestionToAnswer: Game ${selectedGame.uuid} is out of connections`);

					return selectedGame.finish()
					.then( () => {
						Game.writeToDB(selectedGame)
						.catch(err => {
							debug(`getAQuestionToAnswer: Unable to save game state (${selectedGame.uuid}) at limit reached`, err);
							throw err;
						})
						.then(function(){
							debug(`getAQuestionToAnswer: Game state (${selectedGame.uuid}) successfully updated on completion.`);
							return {
								limitReached : true,
								score        : selectedGame.distance,
								history      : selectedGame.history,
								achievedHighestScore     : selectedGame.achievedHighestScore,
								achievedHighestScoreFirst: selectedGame.achievedHighestScoreFirst,
								globalHighestScore : GAMES_STATS.maxScore,
							};
						})
						;
					})
					;
				} else {
					selectedGame.acceptQuestionData( questionData );

					return Game.writeToDB(selectedGame, process.env.GAME_TABLE)
					.catch(err => {
						debug(`getAQuestionToAnswer: Unable to save game state whilst returning answers`, err);
						throw err;
					})
					.then(function(){
						debug(`getAQuestionToAnswer: Game state (${selectedGame.uuid}) successfully updated on generation of answers.`);
						return {
							seed         : selectedGame.seedPerson,
							options      : selectedGame.answersReturned,
							limitReached : false,
							intervalDays : selectedGame.intervalDays,
							questionNum  : selectedGame.distance + 1,
							globalHighestScore : GAMES_STATS.maxScore,
						};
					})
					;
				}
			})
			;
		}
	})
	;
}

function answerAQuestion(gameUUID, submittedAnswer){
	debug(`answerAQuestion: gameUUID=${gameUUID}, submittedAnswer=${JSON.stringify(submittedAnswer)}`);

	if(gameUUID === undefined){
		return Promise.reject('No game UUID was passed to the function');
	} else if(submittedAnswer === undefined){
		return Promise.reject(`An answer was not passed to the function`);
	}

	return Game.readFromDB(gameUUID)
		.then(selectedGame => {
			if(selectedGame === undefined){
				throw `The game UUID '${gameUUID}' is not valid`;
			}

			return new Promise( (resolve) => {
				const result = {
					correct         : undefined,
					score           : selectedGame.distance,
					expected        : selectedGame.nextAnswer,
					linkingArticles : selectedGame.linkingArticles,
					seedPerson      : selectedGame.seedPerson,
					submittedAnswer : submittedAnswer,
					history         : selectedGame.history,
				};

				function normaliseName(name) { return name.replace('.', '').replace('-', ' ').toLowerCase(); }

				if(selectedGame.nextAnswer === undefined){
					throw 'NO_VALID_ANSWER';
				}

				if(normaliseName(submittedAnswer) === normaliseName(selectedGame.nextAnswer)){
					debug(`answerAQuestion: handling a correct answer`);
					selectedGame.distance += 1;
					selectedGame.clearQuestion();

					Game.writeToDB(selectedGame)
						.then(function(){
							result.correct = true;
							result.score   += 1;
							debug(`answerAQuestion: correct answer: result=${JSON.stringify(result,null,2)}` );
							resolve(result);
						})
						.catch(err => {
							debug(`answerAQuestion: Unable to save game state (${selectedGame.uuid}) on correct answering of question`, err);
							throw err;
						})
					;

				} else { // answer was incorrect
					debug(`answerAQuestion: handling an incorrect answer`);

					result.correct = false;
					debug(`answerAQuestion: incorrect answer: result=${JSON.stringify(result,null,2)}` );

					if (selectedGame.state === 'finished') {
						debug(`answerAQuestion: incorrect but repeated. Echo the previous end-of-game summary, without updating any stats.`);
						result.achievedHighestScore      = selectedGame.achievedHighestScore;
						result.achievedHighestScoreFirst = selectedGame.achievedHighestScoreFirst;
						result.globalHighestScore        = GAMES_STATS.maxScore;
						resolve(result);
					} else {
						debug(`answerAQuestion: incorrect. updating stats.`);
						selectedGame.finish()
						.then( () => {
							Game.writeToDB(selectedGame)
								.then(function(){
									// NB: these vals need to be set *after* .finish()
									result.achievedHighestScore      = selectedGame.achievedHighestScore;
									result.achievedHighestScoreFirst = selectedGame.achievedHighestScoreFirst;
									result.globalHighestScore        = GAMES_STATS.maxScore;
									resolve(result);
								})
								.catch(err => {
									debug(`answerAQuestion: Unable to save game state (${selectedGame.uuid}) on incorrect answering of question`, err);
									throw err;
								})
							;
						})
						;
					}
				}

			} );

		})
	;

}

function checkIfAGameExistsForAGivenUUID(gameUUID){

	debug(`checkIfAGameExistsForAGivenUUID: Checking gameUUID ${gameUUID}`);

	return new Promise( (resolve, reject) => {

		if(gameUUID === undefined){
			resolve(false);
		} else {
			Game.readFromDB(gameUUID)
				.then(selectedGame => {
					if(selectedGame === undefined){
						resolve(false);
					} else if(selectedGame.state === 'finished'){
						resolve(false);
					} else {
						resolve(true);
					}
				})
				.catch(err => {
					debug(`checkIfAGameExistsForAGivenUUID: Unable to check if game (${gameUUID}) exists`, err);
					reject(err);
				})
			;
		}

	});

}

function getGameDetails(gameUUID){

	if(gameUUID === undefined){
		throw 'No gameUUID was passed to the function';
	}

	return Game.readFromDB(gameUUID)
		.catch(err => {
			debug(`getGameDetails: Unable to read entry for game ${gameUUID}`, err);
			throw err;
		})
	;
}

function getStats(){
	return {
		correlations_service : correlations_service.stats(),
		games                : GAMES_STATS,
	}
}

module.exports = {
	new        : createANewGame,
	question   : getAQuestionToAnswer,
	answer     : answerAQuestion,
	check      : checkIfAGameExistsForAGivenUUID,
	get        : getGameDetails,
	stats      : getStats,
};
