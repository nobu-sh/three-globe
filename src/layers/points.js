import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderBufferGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  Vector3,
  Vector
} from 'three';

const THREE = window.THREE
  ? window.THREE // Prefer consumption from global THREE, if exists
  : {
    BufferAttribute,
    BufferGeometry,
    Color,
    CylinderBufferGeometry,
    Matrix4,
    Mesh,
    MeshBasicMaterial,
    MeshLambertMaterial,
    Object3D,
    Vector3
};

import * as _bfg from 'three/examples/jsm/utils/BufferGeometryUtils.js';
const bfg = Object.assign({}, _bfg);
const BufferGeometryUtils = bfg.BufferGeometryUtils || bfg;

import Kapsule from 'kapsule';
import accessorFn from 'accessor-fn';
import TWEEN from '@tweenjs/tween.js';

import { colorStr2Hex, colorAlpha } from '../utils/color-utils';
import { emptyObject } from '../utils/gc';
import threeDigest from '../utils/digest';
import { polar2Cartesian } from '../utils/coordTranslate';
import { GLOBE_RADIUS } from '../constants';

//

// support multiple method names for backwards threejs compatibility
const applyMatrix4Fn = new THREE.BufferGeometry().applyMatrix4 ? 'applyMatrix4' : 'applyMatrix';

export default Kapsule({
  props: {
    points: {  default: [], triggerUpdate: false },
    pointsData: { default: [] },
    pointLat: { default: 'lat' },
    pointLng: { default: 'lng' },
    pointColor: { default: () => '#ffffaa' },
    pointAltitude: { default: 0.1 }, // in units of globe radius
    pointRadius: { default: 0.25 }, // in deg
    pointResolution: { default: 12, triggerUpdate: false }, // how many slice segments in the cylinder's circumference
    pointsMerge: { default: false }, // boolean. Whether to merge all points into a single mesh for rendering performance
    pointsTransitionDuration: { default: 1000, triggerUpdate: false } // ms
  },

  init(threeObj, state) {
    // Clear the scene
    emptyObject(threeObj);

    // Main three object to manipulate
    state.scene = threeObj;
  },

  update(state) {
    // Data accessors
    const latAccessor = accessorFn(state.pointLat);
    const lngAccessor = accessorFn(state.pointLng);
    const altitudeAccessor = accessorFn(state.pointAltitude);
    const radiusAccessor = accessorFn(state.pointRadius);
    const colorAccessor = accessorFn(state.pointColor);
    const tooltipAccessor = accessorFn(state.pointTooltip)

    // shared geometry
    const pointGeometry = new THREE.CylinderBufferGeometry(1, 1, 1, state.pointResolution);
    pointGeometry[applyMatrix4Fn](new THREE.Matrix4().makeRotationX(Math.PI / 2));
    pointGeometry[applyMatrix4Fn](new THREE.Matrix4().makeTranslation(0, 0, -0.5));

    const pxPerDeg = 2 * Math.PI * GLOBE_RADIUS / 360;
    const pointMaterials = {}; // indexed by color

    const scene = state.pointsMerge ? new THREE.Object3D() : state.scene; // use fake scene if merging points

    threeDigest(state.pointsData, scene, { createObj, updateObj });

    if (state.pointsMerge) { // merge points into a single mesh
      const pointsGeometry = !state.pointsData.length
        ? new THREE.BufferGeometry()
        : BufferGeometryUtils.mergeBufferGeometries(state.pointsData.map(d => {
            const obj = d.__threeObj;
            d.__threeObj = undefined; // unbind merged points

            const geom = obj.geometry.clone();

            // apply mesh world transform to vertices
            obj.updateMatrix();
            geom[applyMatrix4Fn](obj.matrix);

            // color vertices
            const color = new THREE.Color(colorAccessor(d));
            const nVertices = geom.attributes.position.count;
            const colors = new Float32Array(nVertices * 3);
            for (let i=0, len=nVertices; i<len; i++) {
              const idx = i * 3;
              colors[idx] = color.r;
              colors[idx+1] = color.g;
              colors[idx+2] = color.b;
            }
            geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

            return geom;
          }));

      const points = new THREE.Mesh(pointsGeometry, new THREE.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: true
      }));

      points.__globeObjType = 'points'; // Add object type
      points.__data = state.pointsData; // Attach obj data

      emptyObject(state.scene);
      state.scene.add(points);
    }

    //

    function createObj() {
      const obj = new THREE.Mesh(pointGeometry);

      obj.__globeObjType = 'point'; // Add object type
      state.points.push(obj)
      return obj;
    }

    function updateObj(obj, d) {
      const applyUpdate = td => {
        const { r, alt, lat, lng } = obj.__currentTargetD = td;

        // position cylinder ground
        Object.assign(obj.position, polar2Cartesian(lat, lng));

        // orientate outwards
        const globeCenter = state.pointsMerge
          ? new THREE.Vector3(0, 0, 0)
          : state.scene.localToWorld(new THREE.Vector3(0, 0, 0)); // translate from local to world coords
        obj.lookAt(globeCenter);

        // scale radius and altitude
        obj.scale.x = obj.scale.y = Math.min(30, r) * pxPerDeg;
        obj.scale.z = Math.max(alt * GLOBE_RADIUS, 0.1); // avoid non-invertible matrix
      };

      const targetD = {
        alt: +altitudeAccessor(d),
        r: +radiusAccessor(d),
        lat: +latAccessor(d),
        lng: +lngAccessor(d)
      };

      const currentTargetD = obj.__currentTargetD || Object.assign({}, targetD, {alt: -1e-3});

      if (Object.keys(targetD).some(k => currentTargetD[k] !== targetD[k])) {
        if (state.pointsMerge || !state.pointsTransitionDuration || state.pointsTransitionDuration < 0) {
          // set final position
          applyUpdate(targetD);
        } else {
          // animate
          new TWEEN.Tween(currentTargetD)
            .to(targetD, state.pointsTransitionDuration)
            .easing(TWEEN.Easing.Quadratic.InOut)
            .onUpdate(applyUpdate)
            .start();
        }
      }

      if (!state.pointsMerge) {
        // Update materials on individual points
        const color = colorAccessor(d);
        const opacity = color ? colorAlpha(color) : 0;
        const showCyl = !!opacity;
        obj.visible = showCyl;
        if (showCyl) {
          if (!pointMaterials.hasOwnProperty(color)) {
            pointMaterials[color] = new THREE.MeshLambertMaterial({
              color: colorStr2Hex(color),
              transparent: opacity < 1,
              opacity: opacity
            });
          }
          obj.material = pointMaterials[color];
        }
      }
    }
  }
});
