/**
 * return distance to intersection of a ray with a axis aligned box [[minx,miny,minz],[maxx,maxy,maxz]]
 * @param {*} ro 
 * @param {*} rd 
 * @param {*} aabb 
 */
export function aabbRayIntersection(ro, rd, aabb) {
    var tmin = -Infinity, tmax = Infinity;

    for (var i = 0; i < 3; ++i) {
        if (rd[i] >= 1e-6 || rd[i] <= -1e-6) {
            var t1 = (aabb[0][i] - ro[i]) / rd[i];
            var t2 = (aabb[1][i] - ro[i]) / rd[i];

            tmin = Math.max(tmin, Math.min(t1, t2));
            tmax = Math.min(tmax, Math.max(t1, t2));
        } else {
            if (ro[i] < aabb[0][i] || ro[i] > aabb[1][i])
                return Infinity;
        }
    }

    if (tmax < tmin || tmax < 0)
        return Infinity;

    return tmin > 0 ? tmin : Infinity;

}
