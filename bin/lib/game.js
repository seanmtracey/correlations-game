const debug = require('debug')('bin:lib:game');

// const database = require('./database');
const database = (process.env.DATABASE === 'PRETEND')? require('./database_pretend') : require('./database');
const correlations_service = require('./correlations');
const barnier = require('./barnier-filter'); // Filter names from the game that we know to not work - like Michel Barnier
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
denylist - each seed person is added to this list so they cannot be the seed person in future questions
remainingCandidatesWithConnections - an allowlist of people who could be chosen as seeds
intervalDays - how many days of articles are covered by the current correlations_service
history - record the sequence of questionData items for a summary at the end of a game
achievedHighestScore, achievedHighestScoreFirst - set when finishing a question, based on current best score
*/
const GAMES_STATS_ID = 'UUID_FOR_GAMES_STATS';

const MaxScoreResetAfterMillis = 1000 * 60 * 60 * 24;

let GAMES_STATS = {
	counts      : { created : 0, finished : 0, cloned: 0 },
	scoreCounts : { 0 : 0 }, // { score : count } - prime it with a count of 0 so there is always a counted score
	maxScore    : 0,
	uuid        : GAMES_STATS_ID,
	maxScoreSetMillis : 0, // epoch millis for when the current high score was set.
	maxScoreSetMillisPrev : undefined, // epoch millis for when the prev current high score was set, so we can tell if it has changed.
	maxScoreSetDate : undefined, // display date set after an update
	maxScoreResetAfterMillis : MaxScoreResetAfterMillis, // i.e. reset the highscore if it has not been matched or improved after 24hrs
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

// Using the chain of sets of correlations from the seed person,
// from how many links away from the seed should the 2 'wrong' people be picked?
// The 'correct' answer is from the first link, 0, aka the set of people directly correlated with the seed person.
// From link 1, the people are only indirectly correlated with the seed person (they correlate with a person who correlates with the seed person).
// From link 2, it is one layer of indirection further away from the seed person. Etc.
// The values for these two vars helps set the difficulty of the game.
// Too small, and the wrong answers can be tricky to spot, since on another day they may well correlate directly with the seed person, but just not right now.
// Too large, and the wrong answers are very obviously wrong.
const GAME_DISTANCE_OF_WRONG1 = ( process.env.GAME_DISTANCE_OF_WRONG1 !== undefined )? parseInt(process.env.GAME_DISTANCE_OF_WRONG1) : 2;
const GAME_DISTANCE_OF_WRONG2 = ( process.env.GAME_DISTANCE_OF_WRONG2 !== undefined )? parseInt(process.env.GAME_DISTANCE_OF_WRONG2) : 3;

if (GAME_DISTANCE_OF_WRONG1 < 1) {
	throw `ERROR: process.env.GAME_DISTANCE_OF_WRONG1(${process.env.GAME_DISTANCE_OF_WRONG1}) should be >= 1`
}
if (GAME_DISTANCE_OF_WRONG2 < 1) {
	throw `ERROR: process.env.GAME_DISTANCE_OF_WRONG2(${process.env.GAME_DISTANCE_OF_WRONG2}) should be >= 1`
}

const MAX_CANDIDATES = parseInt( (process.env.MAX_CANDIDATES === undefined)? -1 : process.env.MAX_CANDIDATES );

class Game{
	constructor(userUUID, config=undefined) {
		this.uuid     = userUUID;
		this.player   = userUUID;
		console.log('::new Game');

		// context of current game
		this.state     = 'new';
		this.score     = 0; // was called 'distance'
		this.denylist = []; // will hold all non-available candidates, including chosen seeds, barnier, dead-ends, etc, also populated in createAnNewGame
		this.remainingCandidatesWithConnections = []; // to be populated in createANewGame
		this.remainingCandidatesByName = {}; // to be populated in createANewGame
		this.history   = [];
		this.variant   = GAME_VARIANT.default;
		this.max_candidates = MAX_CANDIDATES;
		this.firstFewMax = parseInt( (process.env.FIRST_FEW_MAX === undefined)? 5 : process.env.FIRST_FEW_MAX );
		this.distance_of_wrong1 = GAME_DISTANCE_OF_WRONG1;
		this.distance_of_wrong2 = GAME_DISTANCE_OF_WRONG2;

		// details+context of the current question
		this.seedPerson          = undefined;
		this.nextAnswer          = undefined;
		this.answersReturned     = undefined;
		this.linkingArticles     = undefined;
		this.intervalDays        = undefined;
		this.achievedHighestScore      = undefined;
		this.achievedHighestScoreFirst = undefined;
		this.isQuestionSet       = false;
		console.log('::new Game this far');
		// pre-pop the denylist with the barnier list
		barnier.list().forEach(uuid => { this.addToDenylist(uuid);});
		console.log('::denylistSetfromBarnier', this.denylist);


		const missing_fields = [];

    // handle when we are re-building a Game instance from a simple obj (e.g. from the DB)
		if( config !== undefined ) {
			if (userUUID !== config['uuid']) {
				throw `Game.constructor: config defined, but mistmatched uuids: userUUID=${userUUID}, config.uuid=${config.uuid}, config=${JSON.stringify(config)}`;
			}
			// a temp fix to bridge the period when stored games might use 'distance' instead of 'score'
			if( config.hasOwnProperty('distance') && !config.hasOwnProperty('score') ){
				config['score'] = config['distance'];
			}

			[
				'uuid', 'player', 'state', 'score', 'denylist',
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

	addToDenylist(name) {
		console.log('::addDeny', name);
		if(name !== undefined){
			debug(`addToDenylist: name=${name}`);
			return this.denylist.push( name.toLowerCase() );
		}
	};
	isDenylisted(name) { return this.denylist.indexOf( name.toLowerCase() ) > -1; };
	filterOutDenylisted(names) { return names.filter( name => {return !this.isDenylisted(name);}) };
	isCandidate(name) { return this.remainingCandidatesByName.hasOwnProperty( name ); };
	filterCandidates(names) { return names.filter( name => {return this.isCandidate(name);}) };

	addCandidates( candidates ) {
		console.log('::addCandidates::')
		let count = 0;
		candidates.forEach( cand => {
			if (this.max_candidates >= 0 && this.max_candidates === count) {
				return;
			}
			const candName = cand[0];

			if (candName.match(/[^:a-zA-Z ]/) !== null ) { // just ignore any names containing non-letters (apart from colon and spaces)
				this.addToDenylist(candName);
			}

			if (! this.isDenylisted(candName)) {
				this.remainingCandidatesWithConnections.push(cand);
				this.remainingCandidatesByName[candName] = cand;
				count = count + 1;
			}
		});
		debug(`Game.addCandidates: added ${count}, all candidates=${Object.keys(this.remainingCandidatesByName)}`);
	}

	denylistCandidate(name){
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

		this.addToDenylist( name );
		debug(`Game.denylistCandidate: name=${name}`);
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
	//   - denylist the seedPerson
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
		if(this.variant === GAME_VARIANT.any_seed || this.variant === GAME_VARIANT.any_seed_kill_answer){
				seedPerson = this.pickNameFromTopFewCandidates();
		} else if(this.variant === GAME_VARIANT.seed_from_answer || this.variant === GAME_VARIANT.seed_from_answer_or_any) {
			if (this.history.length > 0) {
				seedPerson = this.history[this.history.length-1].nextAnswer;
				if (this.isDenylisted(seedPerson)) {
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

		// If we cannot produce a valid seedPerson,
		// it means we cannot proceed with the game so it ends with a undefined question.

		if(seedPerson === undefined){
			return Promise.resolve(undefined);
		}

		// Attempt to construct all the bits for a full valid question.
		// If we can't find any of the bits, we bail.
		// We bail by denylisting the current seedPerson,
		// and starting again with a recursive call to promiseNextCandidateQuestion

		return correlations_service.calcChainLengthsFrom(seedPerson)
			.then(chainLengths => {
				question.seedPerson = seedPerson;
				debug(`promiseNextCandidateQuestion: seedPerson=${seedPerson}, chainLengths.length=${chainLengths.length}`);

				// bail if there are not enough links in the chainlengths to construct a full question
				if (chainLengths.length < 4) {
					debug(`promiseNextCandidateQuestion: reject seedPerson=${seedPerson}: chainLengths.length(${chainLengths.length}) < 4`);
					this.denylistCandidate(seedPerson);
					return this.promiseNextCandidateQuestion();
				}

				// bail if there are no valid direct correlations
				const nextAnswers = this.filterCandidates( chainLengths[1].entities );
				if (nextAnswers.length === 0) {
					debug(`promiseNextCandidateQuestion: reject name=${seedPerson}: nextAnswers.length === 0`);
					this.denylistCandidate(seedPerson);
					return this.promiseNextCandidateQuestion();
				}
				question.nextAnswer = this.pickFromFirstFew( nextAnswers );

				// bail if we can't find a valid wrong answer, starting with furthest (aka wrongest) possible wrong answers
				let wrongAnswers1 = undefined;
				// loop until we find a non-empty list of possible valid answers
				for (var w = 1+this.distance_of_wrong1; w > 1; w--) {
					debug(`promiseNextCandidateQuestion: wrongAnswers1: w=${w}`);
					if( chainLengths.length <= w ) { continue; }
					wrongAnswers1 = this.filterCandidates( chainLengths[w].entities );
					if (wrongAnswers1.length > 0) { break; }
				}
				if (wrongAnswers1 === undefined || wrongAnswers1.length === 0) {
					debug(`promiseNextCandidateQuestion: reject name=${seedPerson}: wrongAnswers1.length === 0`);
					this.denylistCandidate(seedPerson);
					return this.promiseNextCandidateQuestion();
				}
				const firstWrongAnswer = this.pickFromFirstFew( wrongAnswers1 );
				question.wrongAnswers.push( firstWrongAnswer );

				// bail if we can't find another valid wrong answer
				let wrongAnswers2;
				for (var w = 1+this.distance_of_wrong2; w > 1; w--) {
					debug(`promiseNextCandidateQuestion: wrongAnswers2: w=${w}`);
					if( chainLengths.length <= w ) { continue; }
					wrongAnswers2 = this.filterCandidates( chainLengths[w].entities ).filter( name => { return (name !== firstWrongAnswer); } );
					if( wrongAnswers2.length > 0) { break; }
				}
				if (wrongAnswers2 === undefined || wrongAnswers2.length === 0) {
					debug(`promiseNextCandidateQuestion: reject name=${seedPerson}: wrongAnswers2.length === 0`);
					this.denylistCandidate(seedPerson);
					return this.promiseNextCandidateQuestion();
				}
				const secondWrongAnswer = this.pickFromFirstFew( wrongAnswers2 )
				question.wrongAnswers.push( secondWrongAnswer );

				// yay, means we have all the bits needed for a valid question
				question.answersReturned = question.wrongAnswers.slice(0);
				question.answersReturned.push(question.nextAnswer);
				this.shuffle( question.answersReturned );

				debug('qwert', question.seedPerson, question.nextAnswer);

				return correlations_service.calcChainWithArticlesBetween(question.seedPerson, question.nextAnswer)
					.then( data => {
						debug('DARA:', data);
						debug(data.articlesPerLink);
						debug(data.articlesPerLink[0]);
						question.linkingArticles = data.articlesPerLink[0];
						return question;
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

		this.denylistCandidate(this.seedPerson);

		if (this.variant === GAME_VARIANT.any_seed_kill_answer) {
			this.denylistCandidate(this.nextAnswer);
		}

		this.isQuestionSet   = true;

		debug(`Game.acceptQuestionData: seedPerson=${qd.seedPerson}, num remainingCandidatesWithConnections=${this.remainingCandidatesWithConnections.length}`);
	}

	finish(){
		this.state = 'finished';
		return this.updateScoreStats();
	}

	updateScoreStats() {
		const score = this.score;
		const nowMillis = Date.now();
		return Game.updateGamesStats( function(){
			GAMES_STATS.counts.finished += 1;

			{ // ensure we have these vals in place
				if (! GAMES_STATS.scoreCounts.hasOwnProperty(score)) {
					GAMES_STATS.scoreCounts[score] = 0;
				}

				if (! GAMES_STATS.hasOwnProperty('maxScoreSetMillis')) {
					GAMES_STATS.maxScoreSetMillis = nowMillis;
				}

				if (! GAMES_STATS.hasOwnProperty('maxScoreResetAfterMillis')) {
					GAMES_STATS.maxScoreResetAfterMillis = MaxScoreResetAfterMillis;
				}
			}

			GAMES_STATS.scoreCounts[score] += 1;

			if (score > GAMES_STATS.maxScore) {           // new high score!
				GAMES_STATS.maxScoreSetMillis = nowMillis;
				GAMES_STATS.maxScoreSetMillisPrev = undefined;
				GAMES_STATS.maxScore = score;
			} else if( score === 0 ){                     // yeah well, best forgotten
				// make no changes to high score
			} else if (score === GAMES_STATS.maxScore) {  // same high score, more recent timestamp
				GAMES_STATS.maxScoreSetMillisPrev = GAMES_STATS.maxScoreSetMillis;
				GAMES_STATS.maxScoreSetMillis = nowMillis;
			} else if ((nowMillis - GAMES_STATS.maxScoreSetMillis) > GAMES_STATS.maxScoreResetAfterMillis) {
																										// high score is too old, so the new score is the high score
				GAMES_STATS.maxScoreSetMillis = nowMillis;
				GAMES_STATS.maxScoreSetMillisPrev = undefined;
				GAMES_STATS.maxScore = score;
			}

			GAMES_STATS.maxScoreSetDate = new Date(GAMES_STATS.maxScoreSetMillis).toString(); // human-readable age/date of when the high score was set

		})
		.then( () => {
			this.achievedHighestScore      = (score>0 && score === GAMES_STATS.maxScore);
			this.achievedHighestScoreFirst = (this.achievedHighestScore && GAMES_STATS.maxScoreSetMillisPrev === undefined);
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
		console.log('::uid', uuid);
		console.log('::gameStats', GAMES_STATS_ID);
		return database.read({ uuid : uuid }, process.env.GAME_TABLE)
		.then( data => {
			if (data.Item === undefined) {
				return undefined;
			} else if (uuid === GAMES_STATS_ID) {
				return data.Item;
			} else {
				let clonedGame = undefined;
				console.log('dataItem::', data.Item);
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
	console.log('::createANewGame', userUUID);
	if(userUUID === undefined){
		return Promise.reject('No user UUID was passed to the function');
	}
	console.log('::userUUID is defined')

	const newGame = new Game(userUUID);
	debug(`createANewGame: newGame=${JSON.stringify(newGame)}`);
	console.log('::new Game created');
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
				throw 'GAMEOVER';
				return;
			}

			if(selectedGame.isQuestionSet){
				return {
					seed : selectedGame.seedPerson,
					options : selectedGame.answersReturned,
					intervalDays : selectedGame.intervalDays,
					questionNum : selectedGame.score + 1,
					globalHighestScore : GAMES_STATS.maxScore,
				};
			} else {
				// if we are here, we need to pick our seed, nextAnswer, answersReturned
				return selectedGame.promiseNextCandidateQuestion()
					.then(questionData => {
						debug(`getAQuestionToAnswer: questionData=${JSON.stringify(questionData, null, 2)}`);

						if(questionData === undefined){
							debug(`getAQuestionToAnswer: Game ${selectedGame.uuid} is out of connections`);

							return selectedGame.finish()
								.then( () => {
									return Game.writeToDB(selectedGame)
										.then(function(){
											debug(`getAQuestionToAnswer: Game state (${selectedGame.uuid}) successfully updated on completion.`);
											return {
												limitReached : true,
												score        : selectedGame.score,
												history      : selectedGame.history,
												achievedHighestScore     : selectedGame.achievedHighestScore,
												achievedHighestScoreFirst: selectedGame.achievedHighestScoreFirst,
												globalHighestScore : GAMES_STATS.maxScore,
											};
										})
										.catch(err => {
											debug(`getAQuestionToAnswer: Unable to save game state (${selectedGame.uuid}) at limit reached`, err);
											throw err;
										})
									;
								})
							;
						} else {
							selectedGame.acceptQuestionData( questionData );

							return Game.writeToDB(selectedGame, process.env.GAME_TABLE)
								.then(function(){
									debug(`getAQuestionToAnswer: Game state (${selectedGame.uuid}) successfully updated on generation of answers.`);
									return {
										seed         : selectedGame.seedPerson,
										options      : selectedGame.answersReturned,
										limitReached : false,
										intervalDays : selectedGame.intervalDays,
										questionNum  : selectedGame.score + 1,
										globalHighestScore : GAMES_STATS.maxScore,
									};
								})
								.catch(err => {
									debug(`getAQuestionToAnswer: Unable to save game state whilst returning answers`, err);
									throw err;
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
					score           : selectedGame.score,
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
					selectedGame.score += 1;
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
	return Game.updateGamesStats( () => {} ) // just ensure that we have the latest from the DB
	.then( () => {
		return {
			correlations_service : correlations_service.stats(),
			games                : GAMES_STATS,
		};
	})
	;
}

function stopCurrentGame(gameUUID) {
	if(gameUUID === undefined){
		return Promise.reject('No game UUID was passed to the function');
	}

	return Game.readFromDB(gameUUID)
		.then(selectedGame => {
			if(selectedGame === undefined){
				throw `The game UUID '${gameUUID}' is not valid`;
			}

			return selectedGame.finish()
				.then( () => {
					return Game.writeToDB(selectedGame)
						.then(function(){
							debug(`stopCurrentGame: Game state (${selectedGame.uuid}) successfully updated on interruption.`);
							return {
								limitReached : false,
								score        : selectedGame.score,
								history      : selectedGame.history,
								achievedHighestScore     : selectedGame.achievedHighestScore,
								achievedHighestScoreFirst: selectedGame.achievedHighestScoreFirst,
								globalHighestScore : GAMES_STATS.maxScore,
							};
						})
						.catch(err => {
							debug(`stopCurrentGame: Unable to save game state (${selectedGame.uuid}) at limit reached`, err);
							throw err;
						})
					;
				})
			;
		})
	;
}

module.exports = {
	new        : createANewGame,
	question   : getAQuestionToAnswer,
	answer     : answerAQuestion,
	check      : checkIfAGameExistsForAGivenUUID,
	get        : getGameDetails,
	stats      : getStats,
	interrupt  : stopCurrentGame
};
