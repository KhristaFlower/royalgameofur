const path = require('path');
const nodeExternals = require('webpack-node-externals');
const ExtractTextPlugin = require('extract-text-webpack-plugin');

// Used by both the client and the server.
const babelLoaderRules = {
    test: /\.js$/,
    exclude: /(node_modules)/,
    use: {
        loader: 'babel-loader',
        options: {
            presets: ['env']
        }
    }
};

module.exports = [
    {
        target: 'node',
        externals: [nodeExternals()],
        node: {
            __dirname: false,
            __filename: false
        },
        entry: './src/server.js',
        output: {
            filename: 'server.bundle.js',
            path: path.resolve(__dirname, 'dist')
        },
        module: {
            rules: [
                babelLoaderRules
            ]
        }
    },
    {
        entry: [
            './src/client.js'
        ],
        output: {
            filename: 'client.bundle.js',
            path: path.resolve(__dirname, 'dist')
        },
        module: {
            rules: [
                babelLoaderRules,
                {
                    test: /\.scss$/,
                    use: ExtractTextPlugin.extract({
                        use: ['css-loader', 'sass-loader'],
                        fallback: 'style-loader',
                        publicPath: '/dist'
                    })
                }
            ]
        }
        ,
        plugins: [
            new ExtractTextPlugin({
                filename: './style.bundle.css',
                disable: false,
                allChunks: true
            })
        ]
    }
];
