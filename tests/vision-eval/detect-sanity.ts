/** Sanity check: the reduced-size detector still finds people/boats on crowd and rescue photos. */
const tf = await import('@huggingface/transformers');
tf.env.allowRemoteModels = false;
tf.env.localModelPath = 'apps/web/public/models/';
const d = await tf.pipeline('object-detection', 'Xenova/yolos-tiny', { dtype: 'q8' });
for (const f of ['people_waiting_for_rescue__237b892a.jpg', 'people_waiting_for_rescue__e8c69e17.jpg', 'people_waiting_for_rescue__23be7770.jpg', 'people_waiting_for_rescue__cd479e8a.jpg', 'flooded_street__bebff7b1.jpg', 'normal_street__42385479.jpg']) {
  const img = await tf.RawImage.read('tests/fixtures/vision/' + f);
  const o = (await d(img, { threshold: 0.5 })) as { label: string }[];
  console.log(f.padEnd(44), 'persons', o.filter((x) => x.label === 'person').length, 'boats', o.filter((x) => x.label === 'boat').length);
}
