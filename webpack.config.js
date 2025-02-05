const HtmlWebpackPlugin = require('html-webpack-plugin');
const path = require('path');

module.exports = {
    entry: './src/main.js',
    output: {
        filename: 'main.js',
        path: path.resolve(__dirname, 'dist'),
    },
    module: {
        rules: [
            {
                test: /\.glsl$/,
                use: [
                    { loader: 'webpack-glsl-loader' }
                ]
            }
        ]
    },
    plugins: [new HtmlWebpackPlugin({
        template: 'src/index.html'
    })],
    devServer: {
        static: {
            directory: path.join(__dirname, 'src'),
        },
        compress: true,
        port: 8000,
    },
};