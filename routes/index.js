const debug = require('debug')('correlations-game:routes:index');
const express = require('express');
const router = express.Router();

const games = (process.env.GAME === 'LONGER')? require('../bin/lib/gameLonger') : require('../bin/lib/game');

router.get('/', (req, res) => {

	if (process.env.DATABASE === 'PRETEND') {
		res.clearCookie('ftlabsCorrelationsGameUUID');
	}

	res.render('index', {
		userUUID : res.locals.userUUID
	});

});

function processResultForDisplay( result ){
	result.articlesWording = (result.hasOwnProperty('linkingArticles') && result.linkingArticles.length === 1)? 'a recent article' : 'some recent articles';
	if(result.score === 0) {
		result.consecutiveWording = 'correct answers';
	} else if( result.score === 1) {
		result.consecutiveWording = 'correct answer';
	} else {
		result.consecutiveWording = 'consecutive correct answers';
	}
	result.displayable = {};
	[
		'expected', 'seedPerson', 'submittedAnswer'
	].forEach( field => {
		result.displayable[field] = (result[field] === undefined)? '' : result[field].replace('people:', '');
	} );
	result.displayable.history = [];
	if (result.hasOwnProperty('history')) {
		result.history.forEach( h => {
			result.displayable.history.push({
				seedPerson: h.seedPerson.replace('people:', ''),
				nextAnswer: h.nextAnswer.replace('people:', ''),
			});
		});
	}

	if (result.achievedHighestScore) {
		if (result.achievedHighestScoreFirst) {
			result.highestScoreMessage = `Congratulations: you are the first to achieve this high score.`;
		} else {
			result.highestScoreMessage = `Congratulations: you have equalled the current highest score.`;
		}
	} else if( result.globalHighestScore > 0 ){
		result.highestScoreMessage = `The overall highest score is ${result.globalHighestScore}.`;
	} else {
		result.highestScoreMessage = '';
	}

	return result;
}

router.get('/question', (req, res) => {

	games.check(req.cookies['ftlabsCorrelationsGameUUID'])
		.then(gameIsInProgress => {
			debug(`/question: gameIsInProgress ${gameIsInProgress}`)
			if(gameIsInProgress){
				return games.question(req.cookies['ftlabsCorrelationsGameUUID']);
			} else {
				return games.new(req.cookies['ftlabsCorrelationsUserUUID'])
					.then(gameUUID => {
						debug(`/question: new gameUUID=${gameUUID}`);
						const cookieOptions = { httpOnly : false, maxAge : 1000 * 60 * 60 * 24 * 10 }; // 10 day token
						res.cookie('ftlabsCorrelationsGameUUID', gameUUID, cookieOptions);
						return gameUUID;
					})
					.then(gameUUID => games.question(gameUUID))
				;
			}
		})
		.then(result => {
			if(result === undefined) {
				res.render('indexAfterError');
			} else if(result.limitReached === true){
				processResultForDisplay(result);
				res.render('winner', result);
			} else {
				const preparedData = {};

				preparedData.intervalDays = result.intervalDays;

				preparedData.seed = {
					value : result.seed,
					printValue : result.seed.replace('people:', '')
				};

				preparedData.options = {};

				Object.keys(result.options).forEach(key => {
					preparedData.options[key] = {
						value : result.options[key],
						printValue : result.options[key].replace('people:', '')
					};
				});

				preparedData.questionNum = result.questionNum;

				debug(preparedData);

				res.render('question', preparedData);
			}

		})
		.catch(err => {
			debug(err);
			res.render('indexAfterError');
		})

});

router.post('/answer', (req, res) => {

	debug(req.body.answer);

	const submittedAnswer = req.body.answer;

	if(!submittedAnswer){
		res.redirect('/question');
	} else {
		games.answer(req.cookies['ftlabsCorrelationsGameUUID'], req.body.answer)
			.then(result => {
				processResultForDisplay( result );
				if(result.correct === true){
					res.render('correct', {result});
				} else {
					res.render('incorrect', {result});
				}
			})
			.catch( err => {
				debug(err);

				if(err === 'NO_VALID_ANSWER'){
					res.redirect('/question');
				} else {
					res.json({
						status : 'err',
						message : 'An error occurred as we tried to get the question.'
					});
				}

			})
		;
	}

});

router.get('/answer', (req, res) => {

	games.check(req.cookies['ftlabsCorrelationsGameUUID'])
		.then(gameExists => {
			if(gameExists){
				res.redirect('/question');
			} else {
				res.redirect('/');
			}
		})
		.catch(err => {
			debug('\t>>>> err:', err);
		})
	;

});

router.get('/stats', (req, res) => {
	res.json(games.stats());
});

module.exports = router;
