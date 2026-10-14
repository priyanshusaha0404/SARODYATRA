<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
<NamedLayer><Name>pujox_crowd</Name><UserStyle><Title>Crowd pressure (0-100)</Title><FeatureTypeStyle>
 <Rule><Name>crowd</Name><Title>Crowd pressure</Title><RasterSymbolizer><Opacity>0.7</Opacity><ColorMap type="ramp">
   <ColorMapEntry color="#FFF3B0" quantity="0" opacity="0" label="None"/>
   <ColorMapEntry color="#FFE08A" quantity="8" opacity="0.35" label="Low"/>
   <ColorMapEntry color="#F6A21E" quantity="30" opacity="0.6" label="Moderate"/>
   <ColorMapEntry color="#E4572E" quantity="55" opacity="0.75" label="High"/>
   <ColorMapEntry color="#8E1B3A" quantity="85" opacity="0.85" label="Very high"/>
  </ColorMap></RasterSymbolizer></Rule>
</FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>
