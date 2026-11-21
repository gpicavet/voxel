const HtmlWebpackPlugin = require('html-webpack-plugin');
const path = require('path');

// Two builds: the worker first, then the page, which inlines the worker bundle as a string
// (src/world.js imports build/worker.js?raw) and starts it from a Blob URL.
// So the page stays a single file that works from file:// and from the online demo.
module.exports = [
    {
        name: 'worker',
        entry: './src/worker.js',
        target: 'webworker',
        output: {
            filename: 'worker.js',
            path: path.resolve(__dirname, 'build'),
        },
    },
    {
        name: 'main',
        dependencies: ['worker'],
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
                },
                {
                    resourceQuery: /raw/,
                    type: 'asset/source',
                },
            ]
        },
        plugins: [new HtmlWebpackPlugin({
            template: 'src/index.html'
        })],
        devServer: {
            compress: true,
            port: 8000,
        },
    },
];
