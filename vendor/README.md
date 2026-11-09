# 同梱しているライブラリ

電波の無い林内でも動くように、CDN から取ってそのまま置いている (改変していない)。

| ファイル | ライブラリ | 版 | ライセンス | 取得元 |
|---|---|---|---|---|
| proj4.js | proj4js (座標変換) | 2.12.1 | MIT | https://github.com/proj4js/proj4js |
| shp.min.js | shpjs (shapefile の読み込み) | 6.1.0 | MIT | https://github.com/calvinmetcalf/shapefile-js |

日本の座標系の定義 (`../crs_jp.js`) は、解析アプリの `tools/make_crs_jp.py` が pyproj (EPSG) から作ったもの。
