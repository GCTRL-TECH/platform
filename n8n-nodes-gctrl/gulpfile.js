const { src, dest } = require('gulp');

function buildIcons() {
	return src('src/**/*.svg').pipe(dest('dist'));
}

exports['build:icons'] = buildIcons;
