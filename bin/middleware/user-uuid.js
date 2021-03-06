const debug = require('debug')('bin:middleware:user-uuid');
const uuid = require('uuid').v4;

module.exports = (req, res, next) => {

	debug('userUUID:', req.cookies['ftlabsCorrelationsUserUUID']);

	if(req.cookies['ftlabsCorrelationsUserUUID'] === undefined){
		const cookieOptions = { httpOnly : false, maxAge : 1000 * 60 * 60 * 24 * 10 }; // 10 day token
		const generatedUserUUID = uuid();
		res.cookie('ftlabsCorrelationsUserUUID', generatedUserUUID, cookieOptions);
		res.locals.userUUID = generatedUserUUID;
		next();
	} else {
		res.locals.userUUID = req.cookies['ftlabsCorrelationsUserUUID'];
		next();
	}

};